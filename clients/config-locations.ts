/**
 * WHERE pi-lens config lives, and in what order (#2426).
 *
 * Before this module the answer was spread across three loaders with three
 * different walks: `lsp/config.ts` had its own `CONFIG_PATHS` and an UNBOUNDED
 * upward walk to the filesystem root, `project-lens-config.ts` had its own
 * `PROJECT_CONFIG_BASENAMES` and a second unbounded walk, and `lens-config.ts`
 * read one fixed path. Three walks meant three places for the #622/#625
 * ceiling rule to be forgotten, and it was: a `pi-lsp.json` sitting in `$HOME`
 * — or in `C:\` — was read for every project on the machine.
 *
 * There are exactly TWO canonical locations:
 *
 *   `.pi-lens.json`            — project, nearest-package-wins per field
 *   `~/.pi-lens/config.json`   — machine-global
 *
 * Everything else in `PROJECT_CONFIG_LOCATIONS` / `GLOBAL_CONFIG_LOCATIONS` is
 * legacy, read for the deprecation window declared in
 * `DEPRECATED_CONFIG_SURFACES` and then removed. This module does not restate
 * that membership: it DERIVES the legacy set from the registry and orders it,
 * and `tests/clients/config-locations.test.ts` pins that the derived set is
 * exactly the registry's `kind: "file"` rows. Registry owns WHICH surfaces are
 * deprecated; this module owns only their precedence.
 *
 * Pure data, one walk, and — as of the global-config-location PR (refs #2457,
 * #2426) — the ONE existence probe and memoized resolution that decide which
 * file supplies the global tier. The probe is a single `statSync` under the
 * resolution memo; no other file reads, no state beyond that one memo.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEPRECATED_CONFIG_SURFACES } from "./config-diagnostic-codes.js";
import { errorClassName } from "./error-class.js";
import {
	isWindowsPath,
	normalizeFilePath,
	realpathOrResolve,
	toPosix,
	walkUpDirs,
} from "./path-utils.js";

/** The one canonical PROJECT config file. Never deprecated. */
export const CANONICAL_PROJECT_CONFIG_FILE = ".pi-lens.json";

/** Basename of the one canonical GLOBAL config file inside `~/.pi-lens/`. */
export const CANONICAL_GLOBAL_CONFIG_FILE = "config.json";

/** The key the LSP namespace lives under in BOTH canonical files. */
export const LSP_NAMESPACE_KEY = "lsp";

/** The `~/` prefix a global row in the registry carries. */
const GLOBAL_SURFACE_PREFIX = "~/.pi-lens/";

/** One place a config file may be found. */
export interface ConfigLocation {
	/** Path relative to the directory (or global dir) it is looked for in. */
	readonly relativePath: string;
	/**
	 * The `DEPRECATED_CONFIG_SURFACES` surface this location corresponds to, or
	 * `undefined` for a canonical location. Carried so a migration record cites
	 * the registry row rather than re-spelling the window.
	 */
	readonly surface?: string;
	/** True for every location on a removal schedule. */
	readonly legacy: boolean;
	/**
	 * True when the file's ROOT keys are LSP keys (`servers`, `warmFiles`, ...)
	 * rather than pi-lens config sections — i.e. the whole file is what the
	 * canonical files now carry under `lsp`. Derived from the basename rather
	 * than listed, so a new `*lsp.json` legacy row cannot be mis-shaped by
	 * forgetting a second list.
	 */
	readonly lspScoped: boolean;
}

const LEGACY_FILE_SURFACES: readonly string[] =
	DEPRECATED_CONFIG_SURFACES.filter((row) => row.kind === "file").map(
		(row) => row.surface,
	);

/**
 * The legacy LSP ROOT keys still accepted inside a canonical file. Derived from
 * the registry's `kind: "key"` rows so the accepted set and the deprecation
 * schedule cannot drift apart.
 */
export const LEGACY_ROOT_LSP_KEYS: readonly string[] =
	DEPRECATED_CONFIG_SURFACES.filter((row) => row.kind === "key").map(
		(row) => row.surface,
	);

function isLspScoped(relativePath: string): boolean {
	const base = path.posix.basename(toPosix(relativePath));
	return base === "lsp.json" || base === "pi-lsp.json";
}

function legacyLocation(relativePath: string, surface: string): ConfigLocation {
	return {
		relativePath,
		surface,
		legacy: true,
		lspScoped: isLspScoped(relativePath),
	};
}

/**
 * Project locations in ASCENDING precedence: the canonical file is LAST, so it
 * wins every collision with a legacy file in the same directory.
 *
 * This inverts one pre-#2426 rule deliberately. `lsp/config.ts` searched
 * `.pi-lens/lsp.json`, `.pi-lens.json`, `pi-lsp.json` and took the FIRST hit,
 * so a leftover `.pi-lens/lsp.json` silently beat the file the user was being
 * told to migrate to. A deprecated location that outranks the canonical one is
 * a migration that can never be completed.
 */
export const PROJECT_CONFIG_LOCATIONS: readonly ConfigLocation[] = [
	legacyLocation("pi-lens.json", "pi-lens.json"),
	legacyLocation("pi-lsp.json", "pi-lsp.json"),
	legacyLocation(path.posix.join(".pi-lens", "lsp.json"), ".pi-lens/lsp.json"),
	{
		relativePath: CANONICAL_PROJECT_CONFIG_FILE,
		legacy: false,
		lspScoped: false,
	},
];

/**
 * The project config BASENAMES a first-match-wins probe uses, in DESCENDING
 * precedence — canonical first. The inverse view of the table above, for the
 * two callers that look for one file in one directory rather than layering all
 * of them: `project-lens-config.ts`'s upward walk and `workspace-topology.ts`'s
 * directory-marker index.
 *
 * Derived here rather than restated there. Both of those modules carried their
 * OWN literal pair before (#2426 folded the first one in; the marker index's
 * copy outlived it), and two hand-maintained lists of the same filenames is the
 * mirror the single-source-of-truth rule forbids — the failure mode being a
 * table change that flips one probe's collision winner and not the other's.
 *
 * The LSP-scoped legacy locations are filtered out: their ROOT keys are LSP
 * settings, not the pi-lens config sections these two probes project.
 */
export const PROJECT_CONFIG_BASENAMES: readonly string[] =
	PROJECT_CONFIG_LOCATIONS.filter((location) => !location.lspScoped)
		.map((location) => location.relativePath)
		.reverse();

/** Global locations in ASCENDING precedence; canonical last, same rule. */
export const GLOBAL_CONFIG_LOCATIONS: readonly ConfigLocation[] = [
	legacyLocation("lsp.json", `${GLOBAL_SURFACE_PREFIX}lsp.json`),
	{
		relativePath: CANONICAL_GLOBAL_CONFIG_FILE,
		legacy: false,
		lspScoped: false,
	},
];

/**
 * Every legacy surface this module claims to read, for the registry-agreement
 * test. Exported rather than re-derived in the test, so the test compares the
 * SHIPPED set against the registry instead of comparing the registry to itself.
 */
export const DECLARED_LEGACY_FILE_SURFACES: readonly string[] = [
	...PROJECT_CONFIG_LOCATIONS,
	...GLOBAL_CONFIG_LOCATIONS,
]
	.filter((location) => location.legacy)
	.map((location) => location.surface as string);

/** The registry's own `kind: "file"` surfaces, for the same test. */
export const REGISTERED_LEGACY_FILE_SURFACES = LEGACY_FILE_SURFACES;

/**
 * Directories to look for a project config in, INNERMOST FIRST, stopping at the
 * `$HOME` ceiling.
 *
 * The ceiling is the whole point (#622/#625, #2426 scope item 1). `$HOME` and
 * every ancestor of it is refused, so a stray `pi-lsp.json` in the user's home
 * directory — or at the filesystem root — is not silently adopted by every
 * project on the machine. `isAtOrAboveHomeDir` is the shared primitive; a
 * private `dir === homedir()` check is the exact bug #625 catalogued, because
 * it stops at HOME but still reads everything above it.
 *
 * The MACHINE-GLOBAL config is not affected: it is read by absolute path from
 * `~/.pi-lens/`, never by walking into `$HOME` and finding it.
 *
 * `stopAtGitRoot` (#5291) ends the walk at the first directory holding a
 * `.git` entry, that directory included: the layered project read must not
 * merge a file from a folder above the repo (permission keys such as
 * `trivy.enabled`). The test is the ignore matcher's own root rule
 * (`resolveGitIgnoreRoot`), so nothing above the matcher root is read. With no
 * `.git` in the chain the walk keeps the `$HOME` ceiling alone.
 */
export function configSearchDirs(
	startDir: string,
	homeDir: string = os.homedir(),
	stopAtGitRoot = false,
): string[] {
	// #4689 item 6: the walk climbs the start's identity and stops at the
	// home's identity, so neither a link-spelled root nor a link-spelled home
	// moves the ceiling.
	const dirs: string[] = [];
	for (const dir of walkUpDirs(startDir, { homeDir })) {
		dirs.push(dir);
		if (stopAtGitRoot && fs.existsSync(path.join(dir, ".git"))) break;
	}
	return dirs;
}

/**
 * The machine-global pi-lens root is `~/.pi-lens/`, relocated by
 * `PI_LENS_HOME` — owned by `getGlobalPiLensDir()` in `file-utils.ts` and NOT
 * re-derived here: that root is machine STATE (tools, logs, registries),
 * while this module owns only the config-file locations. The global config
 * resolution below deliberately does NOT consult `PI_LENS_HOME` — the
 * #2457 split-brain between that root and the config file stays a separate
 * issue rather than riding on this change.
 */

/**
 * Which tier supplied the resolved global config path.
 *
 * Resolution order (highest first):
 *
 *   1. `pi-lens-config-path`       — `PI_LENS_CONFIG_PATH`, an explicit FILE
 *                                    override. Unchanged, top; the released
 *                                    meaning ("override the GLOBAL config")
 *                                    is not altered here.
 *   2. `legacy-default-existing`   — `~/.pi-lens/config.json`, ONLY when it
 *                                    exists. Current users never move.
 *   3. `pi-coding-agent-dir`       — `$PI_CODING_AGENT_DIR/extensions/
 *                                    pi-lens.json`, ONLY when it exists and
 *                                    step 2 missed. Opt-in by creating the
 *                                    file; an absent file is never chosen for
 *                                    READING.
 *   4. `canonical-default`         — `~/.pi-lens/config.json` (the released
 *                                    canonical spelling, unchanged). This is
 *                                    the tier that fires when NOTHING exists
 *                                    yet.
 *   When tiers 2 and 3 both exist, tier 2 still wins and the loader emits one
 *   bounded shadowing notice naming the winning and shadowed paths (#3299).
 *
 * Probe errors are NOT treated as absent (#3251 review H2, defect shape 48):
 * an unstatable candidate (ENOTDIR when a file sits where a directory
 * belongs, EACCES, ELOOP) RETAINS its tier — the resolution fails closed at
 * the location it could not evaluate, and the load's read of that path is
 * then reported by the pre-existing `reportConfigReadFailure` seam
 * (`PILENS_CFG_0001`). Treating the error as absent would silently switch
 * the config source to a lower tier — different user settings applying with
 * no diagnostic.
 */
export type GlobalConfigLocationSource =
	| "pi-lens-config-path"
	| "legacy-default-existing"
	| "legacy-default-unprobed"
	| "pi-coding-agent-dir"
	| "pi-coding-agent-dir-unprobed"
	| "canonical-default";

export interface GlobalConfigResolution {
	/** The file the global tier reads (or the editor edits). Absolute. */
	readonly path: string;
	/** Which resolution tier decided. */
	readonly source: GlobalConfigLocationSource;
	/** The lower-precedence agent-dir file present while the legacy file won. */
	readonly shadowedPath?: string;
	/**
	 * Set ONLY on the `*-unprobed` sources: the existence probe for `path`
	 * THREW, the tier was retained (fail closed — a silent source switch
	 * would apply different user settings with no diagnostic), and this
	 * carries the failed probe's path plus the error CLASS (never the
	 * message, per the #2431/#2451 rule) for the bounded record the loading
	 * seam emits.
	 */
	readonly existsProbeFailed?: {
		readonly path: string;
		readonly errorClassName: string;
	};
	/**
	 * Set ONLY on the `*-unprobed` sources: an existence probe that THREW (a
	 * file where a directory belongs, permission, ELOOP, ...) RETAINS its
	 * tier — the resolution fails closed at the location it could not
	 * evaluate, and the load's read of that same path reports its own read
	 * failure through the `reportConfigReadFailure` seam (`PILENS_CFG_0001`).
	 */
}

export interface ResolveGlobalConfigLocationOptions {
	/**
	 * Test seam replacing `os.homedir()` for the LEGACY default and, when
	 * `PI_LENS_HOME` is unset, for the canonical default. Production callers
	 * omit it; an options object at all means a fresh, unmemoized computation.
	 */
	readonly homeDir?: string;
	/** Test seam replacing the existence probe. */
	readonly exists?: (path: string) => boolean;
}

function defaultGlobalConfigExists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch (error) {
		// ENOENT is the ordinary ABSENT answer the tier walk consumes. Any other
		// stat failure (ENOTDIR when a file sits where a directory belongs,
		// EACCES, ELOOP) propagates: the discriminated probe in
		// `resolveGlobalConfigLocation` retains the errored tier instead of
		// silently switching config sources (#3251 review H2, defect shape 48),
		// and the load's read of the retained path is reported by the existing
		// `PILENS_CFG_0001` seam.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * The agent-dir config path for one `PI_CODING_AGENT_DIR` value, shared by the
 * resolution and the recognized-location set so the two can never spell the
 * same location differently.
 *
 * Shape-aware joining (defect shape 2): a Windows-shaped agent dir is joined
 * with `path.win32` regardless of host — the host-default `path.resolve` on
 * POSIX treats a drive-letter path as RELATIVE and mangles it, which made a
 * case-folded Windows spelling unmatchable (#3251 review M1).
 */
function agentConfigPathFor(agentDir: string): string {
	return isWindowsPath(agentDir)
		? path.win32.join(
				path.win32.resolve(agentDir),
				"extensions",
				"pi-lens.json",
			)
		: path.join(path.resolve(agentDir), "extensions", "pi-lens.json");
}

/**
 * Resolve which file supplies the global config tier (see
 * `GlobalConfigLocationSource` for the order).
 *
 * Lives here rather than in `lens-config.ts` (#2426 review round 3, S1):
 * this module is the one that already states "WHERE pi-lens config lives",
 * and BOTH discovery seams that must refuse the resolved global path
 * (`project-lens-config.ts`, `workspace-topology.ts`) already import from
 * here — importing the resolver from `lens-config.ts` would close a cycle
 * (`lens-config.ts` itself imports from `project-lens-config.ts`).
 * `lens-config.ts` re-exports the accessors so its own, pre-existing import
 * sites are unaffected.
 */
export function resolveGlobalConfigLocation(
	options?: ResolveGlobalConfigLocationOptions,
): GlobalConfigResolution {
	// An options object means the caller OWNS the resolution context (a test
	// or explicitly-scoped caller): the ambient host env must not leak into it,
	// or a test that resolves-then-writes "under its own home" lands in the
	// maintainer's real config (dogfooded live: ambient PI_CODING_AGENT_DIR
	// redirected a suite's writeConfig into ~/.config/pi/agent/extensions/
	// pi-lens.json). Owned contexts therefore ignore PI_CODING_AGENT_DIR
	// entirely; only the production resolution (no options) walks the
	// host-relative tier. PI_LENS_HOME does not participate in this resolution
	// at all — the canonical default keeps its released homedir spelling, and
	// the #2457 split-brain (which concerns the machine root, not the config
	// file) stays a separate issue.
	const owned = options !== undefined;
	const homeDir = options?.homeDir ?? os.homedir();
	const legacyDefault = path.join(
		homeDir,
		".pi-lens",
		CANONICAL_GLOBAL_CONFIG_FILE,
	);
	// Byte-compatible with the released override: any non-empty value wins,
	// untrimmed, exactly as before.
	const override = process.env.PI_LENS_CONFIG_PATH;
	if (override) {
		return { path: path.resolve(override), source: "pi-lens-config-path" };
	}
	// The probe is DISCRIMINATED (#3251 review H2, defect shape 48): "error"
	// (ENOTDIR when a file sits where a directory belongs, EACCES, ELOOP) is
	// NOT absent — the errored tier is RETAINED, so the load's read of that
	// same path fails and the existing `reportConfigReadFailure` seam
	// (`PILENS_CFG_0001`) reports it. Absorbing the error as ABSENT would
	// silently select a lower tier: different user settings applying with no
	// diagnostic, and the read seam would only ever see the finally-read path,
	// never the probe that failed.
	let probeError: unknown;
	const probe = (file: string): "present" | "absent" | "error" => {
		try {
			return (options?.exists ?? defaultGlobalConfigExists)(file)
				? "present"
				: "absent";
		} catch (error) {
			// The caught error is carried to the retained tier's resolution so
			// the loader's retention record can name the error CLASS (never
			// the message, per the #2431/#2451 rule).
			probeError = error;
			return "error";
		}
	};
	const agentDir = owned ? undefined : process.env.PI_CODING_AGENT_DIR?.trim();
	const agentPath = agentDir ? agentConfigPathFor(agentDir) : undefined;
	const legacyProbe = probe(legacyDefault);
	if (legacyProbe === "present") {
		if (agentPath !== undefined && probe(agentPath) === "present") {
			return {
				path: legacyDefault,
				source: "legacy-default-existing",
				shadowedPath: agentPath,
			};
		}
		return { path: legacyDefault, source: "legacy-default-existing" };
	}
	if (legacyProbe === "error") {
		// Fail closed at the location the probe could not evaluate: the file
		// might exist, and switching sources would silently swap the user's
		// settings. The subsequent read reports the failure (`PILENS_CFG_0001`),
		// and the loader emits the probe-failed retention record.
		return {
			path: legacyDefault,
			source: "legacy-default-unprobed",
			existsProbeFailed: {
				path: legacyDefault,
				errorClassName: errorClassName(probeError),
			},
		};
	}
	if (agentPath !== undefined) {
		const agentProbe = probe(agentPath);
		if (agentProbe === "present") {
			return { path: agentPath, source: "pi-coding-agent-dir" };
		}
		if (agentProbe === "error") {
			// Same rule one tier down: the agent-dir identity is retained, and
			// the read of it reports the failure rather than the resolution
			// silently falling to the canonical default.
			return {
				path: agentPath,
				source: "pi-coding-agent-dir-unprobed",
				existsProbeFailed: {
					path: agentPath,
					errorClassName: errorClassName(probeError),
				},
			};
		}
	}
	return { path: legacyDefault, source: "canonical-default" };
}

/**
 * The process's ONE production global-config resolution.
 *
 * The existence axis is probed ONCE and then FROZEN for the process lifetime,
 * keyed on the two env values that participate. A config location that flips
 * mid-session — because a file appeared between two loads — would silently
 * switch which file supplies every global setting; the resolved identity is
 * carried, not re-derived (#19 in AGENTS.md's recurring-defect shapes). Tests
 * that mutate the env re-resolve via the fingerprint or reset the memo
 * outright with `resetGlobalConfigLocationCache()`.
 *
 * Callers that inject `homeDir`/`exists` bypass the memo: they are test or
 * explicitly-scoped callers that own their resolution context.
 */
interface GlobalConfigResolutionMemo {
	fingerprint: string;
	resolution: GlobalConfigResolution;
}

let memoizedGlobalConfigResolution: GlobalConfigResolutionMemo | undefined;

function globalConfigEnvFingerprint(): string {
	return JSON.stringify([
		process.env.PI_LENS_CONFIG_PATH,
		process.env.PI_CODING_AGENT_DIR,
	]);
}

export function getProductionGlobalConfigResolution(): GlobalConfigResolution {
	const fingerprint = globalConfigEnvFingerprint();
	if (memoizedGlobalConfigResolution?.fingerprint !== fingerprint) {
		memoizedGlobalConfigResolution = {
			fingerprint,
			resolution: resolveGlobalConfigLocation(),
		};
	}
	return memoizedGlobalConfigResolution.resolution;
}

/** Test-only: drop the memoized production resolution so the next call re-probes. */
export function resetGlobalConfigLocationCache(): void {
	memoizedGlobalConfigResolution = undefined;
}

/**
 * The absolute path of the canonical GLOBAL config (see
 * `GlobalConfigLocationSource` for the full resolution order).
 *
 * Lives here rather than in `lens-config.ts` (#2426 review round 3, S1),
 * which is where it originated: this module is the one that already states
 * "WHERE pi-lens config lives", and `project-lens-config.ts` needs this exact
 * function — not a re-derivation of `PI_LENS_CONFIG_PATH` — to name the file a
 * global-only setting belongs in. Importing it from `lens-config.ts` would
 * close a cycle, since `lens-config.ts` itself imports from
 * `project-lens-config.ts`. `lens-config.ts` re-exports this so its own,
 * pre-existing import sites are unaffected.
 */
export function getPiLensGlobalConfigPath(homeDir?: string): string {
	return homeDir === undefined
		? getProductionGlobalConfigResolution().path
		: resolveGlobalConfigLocation({ homeDir }).path;
}

/**
 * Whether `candidate` matches ANY location the global config tier recognizes —
 * the resolved file, the legacy default, and the agent-dir target.
 *
 * The one predicate every project-config discovery seam consults before it
 * adopts a candidate (#783's nested layering, the upward walk, and the
 * workspace marker index): a file the global tier recognizes must not be
 * discovered a second time as a project config — the discovery loader would
 * full-validate it, ignore every global-only key in it, and advise the user
 * to set those keys in the very file it is ignoring. The check covers the
 * POTENTIAL set, not just whichever file currently won the read: a second
 * recognized file that exists but lost the tier walk (the grandfathered
 * legacy file beside an adopted agent-dir file, say) is equally not a project
 * config.
 *
 * Comparison is alias-anchored on BOTH sides (#3251 review M1 round 2):
 * each path is canonicalized through `realpathOrResolve` (resolving existing
 * symlink aliases; a nonexistent path falls back to its resolved spelling —
 * the documented fallback) and then `normalizeFilePath` (separator-agnostic,
 * case-insensitive on Windows, casing-adoption). A symlinked-home alias of a
 * recognized location is therefore the same identity as its real spelling,
 * and a case-folded or separator-differing Windows spelling cannot dodge the
 * refusal either.
 */
export function isResolvedGlobalConfigPath(candidate: string): boolean {
	return recognizedGlobalConfigPaths().has(canonicalPathIdentity(candidate));
}

/**
 * Canonical path identity for one candidate: realpath-anchored so an
 * existing symlink alias resolves to the same identity as its real spelling
 * (#3251 review M1 round 2), with `realpathOrResolve`'s documented
 * nonexistent-path fallback (the resolved spelling, dot-folded and
 * case-normalized by `normalizeFilePath` — which pays its own `realpath`
 * only when the path exists). The discovery seams consult this predicate
 * per config candidate, and the env-derived recognized set is canonicalized
 * with the SAME helper once per env fingerprint, so both sides of the
 * comparison share one identity function.
 */
export function canonicalPathIdentity(candidate: string): string {
	// Shape-aware (defect shape 2): a Windows-shaped path is resolved with
	// `path.win32` — the host resolver on POSIX treats a drive-letter path as
	// RELATIVE and mangles it before any comparison could run. On a real
	// Windows host this arm is the native one, and `normalizeFilePath`'s
	// Windows branch does the alias resolution itself (realpathSync.native
	// plus canonical-casing adoption).
	if (isWindowsPath(candidate)) {
		return normalizeFilePath(path.win32.resolve(candidate));
	}
	return normalizeFilePath(realpathOrResolve(candidate));
}
let recognizedCache: { fingerprint: string; paths: Set<string> } | undefined;

function recognizedGlobalConfigPaths(): Set<string> {
	const fingerprint = globalConfigEnvFingerprint();
	if (recognizedCache?.fingerprint !== fingerprint) {
		const paths = new Set<string>();
		const override = process.env.PI_LENS_CONFIG_PATH;
		if (override) paths.add(canonicalPathIdentity(path.resolve(override)));
		paths.add(
			canonicalPathIdentity(
				path.join(os.homedir(), ".pi-lens", CANONICAL_GLOBAL_CONFIG_FILE),
			),
		);
		const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
		if (agentDir)
			paths.add(canonicalPathIdentity(agentConfigPathFor(agentDir)));
		recognizedCache = { fingerprint, paths };
	}
	return recognizedCache.paths;
}
