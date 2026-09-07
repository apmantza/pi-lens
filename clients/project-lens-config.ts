/**
 * Project-level `.pi-lens.json` config loader.
 *
 * Reads an optional `.pi-lens.json` (or `pi-lens.json`) at the project root and
 * surfaces the fields the rest of pi-lens honors:
 *
 *   - `ignore` — gitignore-style glob patterns added to every scan (LSP walk,
 *     fact-rules, tree-sitter, jscpd, knip, review graph, source-filter). Wired
 *     into `getProjectIgnoreMatcher` in `file-utils.ts` via the existing
 *     `createProjectIgnoreMatcher(rootDir, extraPatterns)` extension point.
 *
 *   - `rules` — per-rule threshold overrides. Currently honored:
 *       rules["high-complexity"].threshold — cyclomatic complexity (default 15)
 *       rules["high-fan-out"].threshold   — distinct-function calls (default 20)
 *
 *   - `maxProjectFiles` — the base project-size scale knob (#776). Read by
 *     `clients/project-scale.ts`'s `getProjectScaleBase`, which derives the
 *     five subsystem size budgets (project-diagnostics scanner, review graph,
 *     startup scan, jscpd, word index) as documented ratios of this value.
 *
 *   - `reviewGraph.maxFiles` — explicit review-graph file-budget override
 *     (#775 R2), for monorepos that want a bigger graph than
 *     `project-scale.ts`'s adaptive taper would derive from
 *     `maxProjectFiles` alone. Tolerantly parsed (numeric strings coerce via
 *     `toPositiveFinite`, same as `maxProjectFiles`) and clamped to
 *     `[100, 20_000]` — a value outside that range is silently clamped
 *     rather than rejected (still an explicit, deliberate opt-in; only a
 *     non-numeric/non-positive value warns and is dropped). Read by
 *     `getReviewGraphMaxFilesDerived`, where it takes precedence over the
 *     taper (but the subsystem's own PRE-EXISTING
 *     `PI_LENS_REVIEW_GRAPH_MAX_FILES` env override still wins outright over
 *     both, unchanged).
 *
 *   - `format.enabled`, `autofix.enabled`, and
 *     `actionableWarnings.autoFix.enabled` — project-owned mutation controls.
 *     These can disable pi-lens writes while leaving diagnostics enabled.
 *
 * The file is loaded once per `(path, mtimeMs)` and cached — editing the file
 * invalidates the cache so the next access sees the new values without
 * restarting pi. Discovery is cached by starting directory and validated by the
 * cached directory mtimes plus the config-file mtime, so hot paths do not repeat
 * candidate-file probes on every dispatch.
 *
 * The loader walks up from the starting directory until it finds a config file
 * (mirroring `lsp/config.ts`'s `loadLSPConfig` so project-monorepos with a
 * `.pi-lens.json` at the repo root work without per-subdir configs).
 *
 * A malformed file is treated as "no config" and logged once — we never want a
 * stray syntax error in user-edited JSON to break diagnostics.
 *
 * `findPiLensConfigInDir` / `loadPiLensConfigInDir` are the per-directory
 * (no upward walk) counterparts used by `file-utils.ts`'s
 * `getProjectIgnoreMatcher` to layer NESTED `.pi-lens.json` `ignore` fields
 * the same way nested `.gitignore`s are already layered (#783): every
 * ancestor directory between the git root and a scanned file is checked for
 * its own config file, so a package-local `.pi-lens.json`'s `ignore`
 * patterns apply to files inside that package, in addition to (and with
 * higher precedence than) the root config's `ignore` patterns.
 */
import {
	resetIgnoredConfigWarnCache,
	warnIgnoredConfigOnce,
} from "./config-warn.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toPositiveFinite } from "./env-utils.js";
import { FRESHNESS_CADENCE_MS } from "./freshness-cadence.js";
import {
	assignFlagConfigSection,
	flagConfigSectionKeys,
	GLOBAL_NON_FLAG_CONFIG_SECTIONS,
	LENS_FLAGS,
	type LensFlagSpec,
	PROJECT_FOREIGN_CONFIG_NAMESPACES,
	PROJECT_FOREIGN_NAMESPACE_HONORED_KEYS,
	PROJECT_NON_FLAG_CONFIG_SECTIONS,
	PROJECT_SCOPED_LENS_FLAGS,
	readFlagConfigValue,
} from "./lens-flag-registry.js";
import {
	type ConfigLocation,
	configSearchDirs,
	getPiLensGlobalConfigPath,
	PROJECT_CONFIG_BASENAMES,
	PROJECT_CONFIG_LOCATIONS,
} from "./config-locations.js";
import {
	type ConfigDocument,
	deprecationRecords,
	ignoredRecordCollector,
	type NoteIgnored,
	projectLocationFor,
	readConfigDocument,
	reportConfigReadFailure,
	reportPiLensConfigRecords,
	resolveOnePiLensConfigDocument,
} from "./config-resolve.js";
import {
	finalizeRecords,
	type MigrationRecord,
} from "./config-core/records.js";
import {
	homeRelativePath,
	isAtOrAboveHomeDir,
	walkUpDirs,
} from "./path-utils.js";
import { findPiLensConfigMarkerInDir } from "./workspace-topology.js";

/**
 * Project config basenames, in DESCENDING precedence (first match wins), for
 * this loader's own discovery.
 *
 * Re-exported from `config-locations.ts`, which owns the derivation, so this
 * loader's long-standing export keeps working while there is exactly ONE list
 * (#2426 review round 2: `workspace-topology.ts` was still carrying a third
 * copy).
 */
export { PROJECT_CONFIG_BASENAMES } from "./config-locations.js";

interface PiLensProjectRuleConfig {
	/** Optional override for the rule's primary numeric threshold. */
	threshold?: number;
	/**
	 * Project-level disable list — rule ids whose diagnostics the project's
	 * `.pi-lens.json` deliberately turns off. Output-only filtering (the
	 * diagnostics are still recorded: widget state, baseline, and dispatch
	 * dedup see them), so a project's own policy never widens the trusted
	 * surface area beyond what the user actually sees. Matching is PROJECT-
	 * WIDE: the `<id>` key this list lives under is a grouping label only, not
	 * a filter scope — every `disable` list across every `rules.<key>` entry
	 * is unioned before matching. Disable is stronger than `select` (below) —
	 * a rule on both lists is dropped.
	 */
	disable?: string[];
	/**
	 * Project-level allowlist — when the UNION of `select` lists across every
	 * `rules.<key>` entry is non-empty, ONLY the rule ids in that union
	 * survive filtering; everything else is dropped, project-wide (an absent
	 * or empty union everywhere is "no restriction"). Like `disable`, the
	 * `<id>` key this list lives under does not scope which rules it can
	 * match. A rule on both `select` and `disable` is dropped (disable wins —
	 * explicit exclusion trumps explicit inclusion).
	 */
	select?: string[];
}

interface PiLensProjectMutationConfig {
	/** Whether this mutation path is enabled for the project. */
	enabled?: boolean;
}

interface PiLensProjectReviewGraphConfig {
	/**
	 * Explicit review-graph file budget, clamped to `[100, 20_000]`.
	 * `undefined` means "derive from `maxProjectFiles` via the taper".
	 */
	maxFiles?: number;
}

/** Clamp bounds for `reviewGraph.maxFiles` — see the field's doc comment above. */
const REVIEW_GRAPH_MAX_FILES_MIN = 100;
const REVIEW_GRAPH_MAX_FILES_MAX = 20_000;

export interface PiLensProjectConfig {
	/** gitignore-style glob patterns added to every diagnostic scan. */
	ignore: string[];
	/** Per-rule threshold overrides; missing keys mean "use hardcoded default". */
	rules: Record<string, PiLensProjectRuleConfig>;
	/** Whether automatic formatting is enabled after write/edit tool calls. */
	format?: PiLensProjectMutationConfig;
	/** Whether the pipeline may apply deterministic linter fixes. */
	autofix?: PiLensProjectMutationConfig;
	/** Project-level controls for actionable-warning behavior. */
	actionableWarnings?: {
		/** Whether conservative warning fixes may run at agent_end. */
		autoFix?: PiLensProjectMutationConfig;
	};
	/**
	 * Base project-size scale knob (#776) — see `clients/project-scale.ts`.
	 * `undefined` means "use the env override / default chain".
	 */
	maxProjectFiles: number | undefined;
	/**
	 * Review-graph-specific overrides (#775 R2). `undefined` (the whole
	 * object, or just `maxFiles`) means "use the adaptive taper" — see
	 * `clients/project-scale.ts`'s `getReviewGraphMaxFilesDerived`.
	 */
	reviewGraph?: PiLensProjectReviewGraphConfig;
	/** The parsed JSON as-is, for forward-compat consumers. */
	raw: unknown;
	/** Absolute path of the config file that was loaded, or undefined if none. */
	configPath: string | undefined;
}

export const EMPTY_PROJECT_CONFIG: PiLensProjectConfig = {
	ignore: [],
	rules: {},
	maxProjectFiles: undefined,
	reviewGraph: undefined,
	raw: undefined,
	configPath: undefined,
};

interface CacheEntry {
	mtimeMs: number;
	/**
	 * Byte size at parse time (#1105). Reuse requires BOTH mtime and size to
	 * match — size is the free second axis (the same stat already read it) that
	 * catches an mtime-preserving, length-changing in-place edit (git checkout,
	 * same-second rewrite) that mtime alone would replay stale. Residual (same
	 * mtime AND same size) matches the review-graph `size:mtimeMs` accepted
	 * residual; closing it would need a content hash on every gate check — the
	 * hot-path cost the word-index #1105 fix deliberately declined.
	 */
	size: number;
	config: PiLensProjectConfig;
	/**
	 * The migration records `parseConfigFile` produced for this file (#2426
	 * review round 3, F2) — cached alongside the config so a cache HIT can still
	 * re-report them (cheap: no I/O, just replays through the warn seam, whose
	 * own per-session latch decides whether anything new actually fires).
	 * Without this, a repeat load of the SAME unchanged deprecated file recorded
	 * a `config-deprecated` ledger row only in the session that first parsed it.
	 */
	records: readonly MigrationRecord[];
	/**
	 * This loader's OWN `config-ignored` records — the unknown-key, bad-value
	 * and malformed-`rules` warnings `parseConfigFile` composes (#2426 review
	 * round 4, F3).
	 *
	 * They were emitted DURING the parse and never captured, so the cache-HIT
	 * replay carried only the deprecation half: session 2 of a warm process
	 * recorded a `config-deprecated` row for the same file and no
	 * `config-ignored` row at all, even though every one of those settings was
	 * still being dropped. Same lifetime argument as `records` above — content
	 * caching and per-session reporting are different lifetimes.
	 */
	ignored: readonly MigrationRecord[];
}

/** The identity of one file a cached derivation was computed from. */
interface FileStamp {
	path: string;
	mtimeMs: number;
	size: number;
}

interface DiscoveryCacheEntry {
	info: PiLensProjectConfigFileInfo | undefined;
	dirMtimes: Array<{ dir: string; mtimeMs: number }>;
	/**
	 * Deprecation records for every LEGACY config document at or above the start
	 * directory (#2426 review round 4, F4) — for RECORD purposes only; none of
	 * these documents is merged into the returned config.
	 */
	legacyRecords: readonly MigrationRecord[];
	/** The legacy documents `legacyRecords` was derived from, for freshness. */
	legacySources: readonly FileStamp[];
	/**
	 * When this entry was built (#2483 round 2). Only consulted for the
	 * no-`info` case — see `discoveryCacheStillFresh` — where `dirMtimes` is
	 * scoped to `startDir` alone (`bearingDirMtimes`'s no-`info` branch) and so
	 * cannot by itself see a config file newly created further up the chain.
	 */
	checkedAtMs: number;
}

/** Cache by absolute config path; we read each candidate's mtime before reuse. */
const configCache = new Map<string, CacheEntry>();
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/**
 * The shared body of `loadPiLensProjectConfig` and `loadPiLensConfigInDir`:
 * reuse a fresh cache entry, or parse and cache one, and — EITHER WAY (#2426
 * review round 3, F2) — report the resolution's migration records. Content
 * caching (skip re-reading unchanged bytes off disk) and per-session
 * reporting (tell the user once a session about a deprecated setting) are two
 * different lifetimes; folding "already cached" into "already reported"
 * silently dropped the report the moment the file stopped changing.
 */
function loadCachedConfigFile(
	info: PiLensProjectConfigFileInfo,
): PiLensProjectConfig {
	const cached = configCache.get(info.path);
	if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
		replayConfigNotices(cached);
		return cached.config;
	}

	const parsed = parseConfigFile(info.path);
	const entry: CacheEntry = {
		mtimeMs: info.mtimeMs,
		size: info.size,
		config: parsed.config,
		records: parsed.records,
		ignored: parsed.ignored,
	};
	configCache.set(info.path, entry);
	replayConfigNotices(entry);
	return parsed.config;
}

/**
 * Report BOTH classes of notice a parse produced (#2426 review round 4, F3).
 *
 * The resolution's records go through the shared seam, which derives each
 * one's subsystem from the record. This loader's own records do not: they are
 * `project-lens-config`'s by construction — it composed their prose — so
 * routing them through that derivation would relabel `"lsp.enabled" is a
 * global-only pi-lens setting` as an LSP-config problem, which is the opposite
 * of what it says.
 */
function replayConfigNotices(entry: {
	records: readonly MigrationRecord[];
	ignored: readonly MigrationRecord[];
}): void {
	reportPiLensConfigRecords(entry.records);
	for (const record of entry.ignored) {
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: record.file,
			reason: record.reason,
			code: record.code,
		});
	}
}

/**
 * Walk up from `startDir` looking for a `.pi-lens.json` or `pi-lens.json`.
 * Returns the parsed config, or an empty config if none was found.
 */
export function loadPiLensProjectConfig(
	startDir: string,
	preloadedInfo?: PiLensProjectConfigFileInfo,
): PiLensProjectConfig {
	// ONE discovery per load (#2426 review round 5, F-C). The legacy-document
	// enumeration below and the config-file lookup are two READS of the same
	// cache entry, and resolving that entry twice — the default argument once,
	// the record replay again — doubled the freshness stats every warm load
	// pays, on a path called per dispatch. The entry is resolved here and both
	// halves read it.
	const entry = discoveryEntryFor(startDir);
	// #2426 review round 4, F4. The half-migrated notices — a legacy
	// `pi-lens.json` sitting BESIDE or ABOVE the canonical `.pi-lens.json` this
	// walk stops at — used to be produced only by `loadLSPConfig`, whose
	// discovery collects from every bearing directory rather than stopping at
	// the first. Under `--no-lsp`, `lsp.enabled: false`, or a subagent session
	// (#449, routine) that loader never runs, and the pi-lens-OWNED records for
	// a pi-lens-owned file were then produced by nobody at all. The pi-lens
	// loader now enumerates those documents itself, for records only: nothing
	// here is merged, and which file supplies a VALUE is unchanged.
	reportPiLensConfigRecords(entry.legacyRecords);
	const configInfo = preloadedInfo ?? freshInfoFor(entry);
	if (!configInfo) return EMPTY_PROJECT_CONFIG;
	return loadCachedConfigFile(configInfo);
}

/** For tests + callers that need to force a re-read (e.g. config-watcher hooks). */
export function resetProjectLensConfigCache(): void {
	configCache.clear();
	discoveryCache.clear();
	resetIgnoredConfigWarnCache("project-lens-config");
}

export interface PiLensProjectConfigFileInfo {
	path: string;
	dir: string;
	mtimeMs: number;
	/** Byte size at stat time — the #1105 second freshness axis (see CacheEntry). */
	size: number;
}

/**
 * Look for a `.pi-lens.json`/`pi-lens.json` directly IN `dir` — no upward
 * walk. Used to layer nested per-package configs (#783) the same way
 * `file-utils.ts` layers nested `.gitignore`s: each ancestor directory
 * between the git root and a target file is checked for its OWN config
 * file, independent of whatever config `loadPiLensProjectConfig`'s upward
 * walk would find starting from `dir`.
 *
 * Sourced from the shared workspace-topology marker index (#806) — one
 * `readdir` pass per directory visit collects this marker alongside
 * `tsconfig.json`/workspace-manifest markers other consumers need for the
 * SAME directory, instead of each subsystem re-probing it independently.
 */
export function findPiLensConfigInDir(
	dir: string,
): PiLensProjectConfigFileInfo | undefined {
	const marker = findPiLensConfigMarkerInDir(dir);
	if (!marker) return undefined;
	return {
		path: marker.path,
		dir: marker.dir,
		mtimeMs: marker.mtimeMs,
		size: marker.size,
	};
}

export interface NestedProjectMutationValue {
	value: boolean;
	dir: string;
}

/**
 * Find the closest config, between an edited file and the project root, that
 * explicitly defines one mutation flag. The walk uses the shared primitive
 * and refuses to inspect HOME or any ancestor of HOME.
 */
export function findNestedProjectMutationValue(
	spec: LensFlagSpec,
	editedFilePath: string,
	projectRoot: string,
	homeDir = os.homedir(),
): NestedProjectMutationValue | undefined {
	const root = path.resolve(projectRoot);
	const start = path.dirname(path.resolve(editedFilePath));
	for (const dir of walkUpDirs(start)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;
		const rel = path.relative(root, dir);
		if (rel.startsWith("..") || path.isAbsolute(rel)) break;
		const config = loadPiLensConfigInDir(dir);
		const enabled = readFlagConfigValue(config, spec.configKey);
		if (enabled !== undefined) return { value: enabled, dir };
		if (dir === root) break;
	}
	return undefined;
}

/**
 * Load the `.pi-lens.json`/`pi-lens.json` directly IN `dir` (no upward
 * walk) — the per-directory counterpart to `loadPiLensProjectConfig`'s
 * upward-walking discovery. Shares `configCache` (keyed by absolute config
 * path + mtime), so a directory whose config was already loaded via the
 * upward-walk path (e.g. the git root itself) is not re-read here.
 */
export function loadPiLensConfigInDir(dir: string): PiLensProjectConfig {
	const info = findPiLensConfigInDir(dir);
	if (!info) return EMPTY_PROJECT_CONFIG;
	return loadCachedConfigFile(info);
}

/** The cached discovery for `startDir`, recomputed when it is no longer fresh. */
function discoveryEntryFor(startDir: string): DiscoveryCacheEntry {
	const cacheKey = path.resolve(startDir);
	const cached = discoveryCache.get(cacheKey);
	if (cached && discoveryCacheStillFresh(cached)) return cached;
	const discovered = discoverPiLensProjectConfig(cacheKey);
	discoveryCache.set(cacheKey, discovered);
	return discovered;
}

export function findPiLensProjectConfig(
	startDir: string,
): PiLensProjectConfigFileInfo | undefined {
	return freshInfoFor(discoveryEntryFor(startDir));
}

/**
 * The winning config file's info, re-statted.
 *
 * Split out of `findPiLensProjectConfig` so a caller that already holds the
 * discovery entry does not resolve it a second time to get here (#2426 review
 * round 5, F-C). The re-stat itself stays: the entry can be fresh by directory
 * mtime while the config file was rewritten in place, and the caller keys its
 * content cache on the mtime/size this returns.
 */
function freshInfoFor(
	entry: DiscoveryCacheEntry,
): PiLensProjectConfigFileInfo | undefined {
	if (!entry.info) return undefined;
	const stat = safeFileStat(entry.info.path);
	if (!stat?.isFile()) return entry.info;
	return { ...entry.info, mtimeMs: stat.mtimeMs, size: stat.size };
}

function safeFileStat(filePath: string): fs.Stats | undefined {
	try {
		return fs.statSync(filePath);
	} catch {
		return undefined;
	}
}

function safeDirMtimeMs(dir: string): number {
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return -1;
	}
}

function discoveryCacheStillFresh(entry: DiscoveryCacheEntry): boolean {
	if (
		!entry.dirMtimes.every(
			(cached) => safeDirMtimeMs(cached.dir) === cached.mtimeMs,
		)
	) {
		return false;
	}
	// #2483 round 2. When no config was found anywhere, `bearingDirMtimes`'s
	// no-`info` branch scopes `dirMtimes` to `startDir` alone, so the `.every`
	// above can only ever see churn AT `startDir` — a config file created at
	// any ancestor above it moves nothing this entry tracks, and the entry
	// would then read as fresh for the rest of the process (no production
	// caller resets it, and a same-`startDir` load never rediscovers). The
	// issue's acceptance line rules that out ("a new config file created in
	// the chain IS noticed (bounded staleness stated)"), so a no-`info` entry
	// is force-expired at most once per `FRESHNESS_CADENCE_MS` regardless of
	// what `dirMtimes` says — the same negative-cache cadence bound
	// `file-utils.ts`'s `patternsForDir` already applies to its own no-match
	// case, reused rather than a second cadence mechanism invented here. The
	// forced re-walk that follows re-stats the FULL ancestor chain (see
	// `discoverPiLensProjectConfig`), so a config created anywhere in it is
	// found — bounded to at most one cadence window of staleness, not
	// unbounded.
	if (
		entry.info === undefined &&
		Date.now() - entry.checkedAtMs >= FRESHNESS_CADENCE_MS
	) {
		return false;
	}
	// A legacy document can be EDITED in place without its directory's mtime
	// moving, and its top-level key set is what `legacyRecords` describes — so
	// those files carry their own freshness axis, the same (mtime, size) pair
	// `CacheEntry` uses.
	return entry.legacySources.every((source) => {
		const stat = safeFileStat(source.path);
		return (
			stat?.isFile() === true &&
			stat.mtimeMs === source.mtimeMs &&
			stat.size === source.size
		);
	});
}

const LEGACY_PROJECT_LOCATIONS: readonly ConfigLocation[] =
	PROJECT_CONFIG_LOCATIONS.filter((location) => location.legacy);

function discoverPiLensProjectConfig(startDir: string): DiscoveryCacheEntry {
	const dirMtimes: Array<{ dir: string; mtimeMs: number }> = [];
	const legacyDocuments: ConfigDocument[] = [];
	const legacySources: FileStamp[] = [];
	let info: PiLensProjectConfigFileInfo | undefined;
	// #2426: ceiling-bounded, same rule and same shared primitive as the LSP
	// loader and as `findNestedProjectMutationValue` below. This walk ran to the
	// filesystem root before, so a `.pi-lens.json` in `$HOME` (or at `C:\`) was
	// adopted by every project on the machine — the #622/#625 class.
	//
	// It no longer STOPS at the first bearing directory (#2426 review round 4,
	// F4): the first hit still decides `info`, and therefore still decides every
	// value this loader returns, but the walk continues to the ceiling so the
	// legacy documents a user is being asked to migrate are enumerated wherever
	// they sit — beside the winning file or above it.
	for (const dir of configSearchDirs(startDir)) {
		dirMtimes.push({ dir, mtimeMs: safeDirMtimeMs(dir) });
		if (!info) {
			for (const name of PROJECT_CONFIG_BASENAMES) {
				const candidate = path.join(dir, name);
				const stat = safeFileStat(candidate);
				if (stat?.isFile()) {
					info = {
						path: candidate,
						dir,
						mtimeMs: stat.mtimeMs,
						size: stat.size,
					};
					break;
				}
			}
		}
		for (const location of LEGACY_PROJECT_LOCATIONS) {
			const file = path.join(dir, location.relativePath);
			const stat = safeFileStat(file);
			if (!stat?.isFile()) continue;
			legacySources.push({
				path: file,
				mtimeMs: stat.mtimeMs,
				size: stat.size,
			});
			const outcome = readConfigDocument(file);
			if (outcome.status === "error") {
				reportConfigReadFailure({
					file,
					location,
					tier: "project",
					error: outcome.error,
					sourceText: outcome.sourceText,
				});
				continue;
			}
			if (outcome.status !== "ok") continue;
			legacyDocuments.push({
				tier: "project",
				file,
				location,
				value: outcome.value,
			});
		}
	}
	return {
		info,
		dirMtimes: bearingDirMtimes(dirMtimes, info),
		legacyRecords: legacyDeprecationRecords(legacyDocuments),
		legacySources,
		checkedAtMs: Date.now(),
	};
}

/**
 * The legacy documents' deprecation records, BOUNDED per document (#2426
 * review round 5, F-A/F-B).
 *
 * This path shipped its records raw. A legacy file's recognized top-level key
 * count is user input, so one 28-key `pi-lens.json` produced 28 notifications
 * through this loader while the LSP loader — which finalizes the same records —
 * produced the bound plus a count for the identical file, and five nested
 * legacy files produced 145 with no suppression record anywhere. Every producer
 * now goes through the one \`finalizeRecords\`.
 *
 * Per DOCUMENT rather than per walk, because these are not one resolution: each
 * file is separately actionable ("move these keys out of THIS file"), and a
 * per-walk bound would silently drop whole files' advice while naming only the
 * last one. Per document also makes the two loaders agree on the count for a
 * given file, which is the parity `config-notice-ownership` asserts.
 */
function legacyDeprecationRecords(
	documents: readonly ConfigDocument[],
): readonly MigrationRecord[] {
	const home = os.homedir();
	return documents.flatMap((document) =>
		finalizeRecords(deprecationRecords([document], home), {
			file: document.file,
			tier: document.tier,
		}),
	);
}

/**
 * The directory mtimes this entry's freshness is keyed on: the BEARING chain —
 * `startDir` up to and including the directory that supplied `info` (#2426
 * review round 5, F-C).
 *
 * The walk itself no longer stops at the first bearing directory, because the
 * legacy documents a user is asked to migrate can sit above it. Keying
 * freshness on every directory it VISITS is a different decision, and a bad
 * one: the walk runs to just below `$HOME`, so the entry was invalidated by any
 * churn in an ancestor like `~/Desktop` — a full re-walk, re-read and re-parse
 * of every legacy document, on a hot path, triggered by an unrelated directory.
 *
 * Scoping it back to the bearing chain restores the pre-#2426 invalidation
 * surface exactly. Nothing that decides a VALUE is outside that chain, and an
 * already-discovered legacy document above it carries its own (mtime, size)
 * stamp in `legacySources`, so an EDIT to one is still noticed. What is given
 * up is noticing a legacy file NEWLY CREATED above the bearing directory
 * mid-process — records-only, and strictly more than the pre-#2426 loader saw,
 * since it never looked above that directory at all.
 *
 * When NO config file is found anywhere (#2483), `info` is undefined and there
 * is no bearing directory to stop at — but the majority of projects have no
 * config at all, so this is the COMMON case, not an edge one. Falling back to
 * the full chain here (the pre-fix behavior) keyed freshness on every
 * directory up to just below `$HOME`: unrelated churn in `~/Desktop` or
 * `~/projects` invalidated the entry and forced a full re-walk on the very
 * next load, every load, forever.
 *
 * The nearest directory a config COULD have appeared in is `startDir` itself
 * — `dirMtimes[0]`, first in the innermost-first walk order (`configSearchDirs`)
 * — so that is what per-call freshness is scoped to, the same bearing-directory
 * principle as the presence case (a directory always includes itself as the
 * degenerate bearing chain). A config file created directly in `startDir`
 * bumps `startDir`'s own mtime and is found on the next load.
 *
 * A config file created further up the chain does not move `startDir`'s own
 * mtime, so it is invisible to THIS check alone (round 1 of #2483 stopped
 * here, leaving staleness unbounded — no production caller ever resets the
 * cache and a same-`startDir` load never rediscovers). `discoveryCacheStillFresh`
 * closes that gap: a no-`info` entry is force-expired at most once per
 * `FRESHNESS_CADENCE_MS`, independent of what `dirMtimes` says, which sends
 * the NEXT load through a full re-walk of the ancestor chain regardless — so
 * a config created anywhere in it is noticed within one cadence window.
 * Bounded staleness, and strictly narrower than the pre-fix "any ancestor up
 * to $HOME invalidates on every load".
 */
function bearingDirMtimes(
	dirMtimes: readonly { dir: string; mtimeMs: number }[],
	info: PiLensProjectConfigFileInfo | undefined,
): Array<{ dir: string; mtimeMs: number }> {
	if (info) {
		const bearing = dirMtimes.findIndex((entry) => entry.dir === info.dir);
		return bearing < 0 ? [...dirMtimes] : dirMtimes.slice(0, bearing + 1);
	}
	return dirMtimes.slice(0, 1);
}

function parseRulePolicyList(
	note: NoteIgnored,
	ruleId: string,
	key: "disable" | "select",
	value: unknown,
): { list: string[]; invalid: boolean } {
	if (!Array.isArray(value)) {
		note(`rules.${ruleId}.${key} must be an array of strings`);
		return { list: [], invalid: true };
	}
	const list: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length > 0) list.push(trimmed);
	}
	if (list.length === 0) {
		// #1087: an explicitly empty array (`"disable": []`) is a well-formed
		// no-op, not an error — don't warn. Only warn when the array HAD entries
		// but none were usable strings (all blank / non-string), which is a real
		// authoring mistake that must not fail silently.
		if (value.length > 0) {
			note(`rules.${ruleId}.${key} must contain at least one non-empty string`);
			return { list: [], invalid: true };
		}
		return { list: [], invalid: false };
	}
	return { list, invalid: false };
}

/** A parsed config plus the two classes of record it produced. */
interface ParsedConfigFile {
	config: PiLensProjectConfig;
	/** From the shared resolution: deprecations and core validation drops. */
	records: readonly MigrationRecord[];
	/** This loader's own `config-ignored` records (#2426 review round 4, F3). */
	ignored: readonly MigrationRecord[];
}

const NO_RECORDS: readonly MigrationRecord[] = [];

function parseConfigFile(configPath: string): ParsedConfigFile {
	const { note, records: ignoredRecords } = ignoredRecordCollector(
		configPath,
		"project",
	);
	const outcome = readConfigDocument(configPath);
	if (outcome.status === "error") {
		// `{ parseError }`, not a pre-stringified message (#2431): the raw error
		// reaches one seam, which decides how much of a `JSON.parse`
		// `SyntaxError#message` (which embeds a snippet of the file being parsed)
		// survives into the sinks.
		note({ parseError: outcome.error, sourceText: outcome.sourceText });
		return {
			config: EMPTY_PROJECT_CONFIG,
			records: NO_RECORDS,
			ignored: ignoredRecords(),
		};
	}
	// The file was stat'd as present by the discovery above, so `missing` here is
	// a delete that raced the read. Nothing to warn about — the next call
	// re-discovers and finds no config at all.
	if (outcome.status === "missing") {
		return {
			config: EMPTY_PROJECT_CONFIG,
			records: NO_RECORDS,
			ignored: NO_RECORDS,
		};
	}

	if (
		!outcome.value ||
		typeof outcome.value !== "object" ||
		Array.isArray(outcome.value)
	) {
		note("top-level value must be an object");
		return {
			config: EMPTY_PROJECT_CONFIG,
			records: NO_RECORDS,
			ignored: ignoredRecords(),
		};
	}

	// Through the #2425 core (#2426): the value is validated against the
	// canonical schema before this loader's own field parsing sees it, so the
	// depth bound, the prototype-key policy and the declared `lsp.*` types apply
	// here exactly as they do in the LSP loader. `raw` is the VALIDATED value
	// rather than the parse output, which is the one place the field's
	// documented "the parsed JSON as-is" narrows: a `__proto__` key or a
	// 4000-deep blob no longer rides into `.raw`'s consumers (`trivy-client.ts`,
	// the helm-render runner).
	const resolved = resolveOnePiLensConfigDocument({
		tier: "project",
		file: configPath,
		location: projectLocationFor(configPath),
		value: outcome.value,
	});
	// The records are RETURNED, not reported here (#2426 review round 3, F2):
	// this function's result is what the caller caches, and a cache HIT must
	// still report them every session — a call this function never makes on a
	// hit. Reporting here would fire only on a cache MISS (session 1), and
	// `resetProjectLensConfigCache` has no production caller, so every session
	// after the first silently lost the `config-deprecated` ledger row despite
	// the file still being the exact deprecated one on disk.
	const raw: unknown = resolved.value;
	const obj = resolved.value;

	const ignore = Array.isArray(obj.ignore)
		? obj.ignore.filter((p): p is string => typeof p === "string")
		: [];
	const mutations: Record<string, unknown> = {};
	for (const spec of PROJECT_SCOPED_LENS_FLAGS) {
		assignFlagConfigSection(obj, mutations, spec.configKey, note);
	}

	const rules: Record<string, PiLensProjectRuleConfig> = {};
	if (obj.rules && typeof obj.rules === "object" && !Array.isArray(obj.rules)) {
		const rawRules = obj.rules as Record<string, unknown>;
		for (const [ruleId, ruleCfg] of Object.entries(rawRules)) {
			// #444's own example writes the lists directly under `rules` (`rules.
			// disable`), which lands here as an array and would otherwise be
			// dropped without a word — the one shape a user is most likely to try.
			if (!ruleCfg || typeof ruleCfg !== "object" || Array.isArray(ruleCfg)) {
				note(
					`rules.${ruleId} must be an object with threshold, disable, or select; ignored`,
				);
				continue;
			}
			const r = ruleCfg as Record<string, unknown>;
			const entry: PiLensProjectRuleConfig = {};
			if (
				typeof r.threshold === "number" &&
				Number.isFinite(r.threshold) &&
				r.threshold > 0
			) {
				entry.threshold = r.threshold;
			} else if ("threshold" in r) {
				note(`rules.${ruleId}.threshold must be a positive finite number`);
			}
			if ("disable" in r) {
				const parsed = parseRulePolicyList(note, ruleId, "disable", r.disable);
				// #1087: an explicitly empty list is valid-but-empty (no warning);
				// don't store a pointless no-op entry for it.
				if (!parsed.invalid && parsed.list.length > 0)
					entry.disable = parsed.list;
			}
			if ("select" in r) {
				const parsed = parseRulePolicyList(note, ruleId, "select", r.select);
				if (!parsed.invalid && parsed.list.length > 0)
					entry.select = parsed.list;
			}
			// Honor both threshold-only and policy-only entries; only drop if
			// the entry had no recognized fields at all (e.g. { unrelated: true }).
			// A recognized-but-malformed field already warned above, so only warn
			// here when nothing recognized was spelled at all — #444 proposed
			// `only` rather than `select`, and that typo must not fail silent.
			if (entry.threshold !== undefined || entry.disable || entry.select) {
				rules[ruleId] = entry;
			} else if (!("threshold" in r) && !("disable" in r) && !("select" in r)) {
				note(
					`rules.${ruleId} has no recognized setting (threshold, disable, select); ignored`,
				);
			}
		}
	}

	let maxProjectFiles: number | undefined;
	if ("maxProjectFiles" in obj) {
		if (
			typeof obj.maxProjectFiles === "number" &&
			Number.isFinite(obj.maxProjectFiles) &&
			obj.maxProjectFiles > 0
		) {
			maxProjectFiles = obj.maxProjectFiles;
		} else {
			note("maxProjectFiles must be a positive finite number");
		}
	}

	let reviewGraph: PiLensProjectReviewGraphConfig | undefined;
	if (obj.reviewGraph !== undefined) {
		if (
			!obj.reviewGraph ||
			typeof obj.reviewGraph !== "object" ||
			Array.isArray(obj.reviewGraph)
		) {
			note("reviewGraph must be an object");
		} else {
			const rg = obj.reviewGraph as Record<string, unknown>;
			if ("maxFiles" in rg) {
				const parsed = toPositiveFinite(rg.maxFiles);
				if (parsed > 0) {
					const clamped = Math.min(
						REVIEW_GRAPH_MAX_FILES_MAX,
						Math.max(REVIEW_GRAPH_MAX_FILES_MIN, Math.floor(parsed)),
					);
					reviewGraph = { maxFiles: clamped };
				} else {
					note("reviewGraph.maxFiles must be a positive finite number");
				}
			}
		}
	}

	// #533 hygiene: mirror the global loader's unknown-key warn so a typo in a
	// shared `.pi-lens.json` (e.g. `maxProjectFile`, `lps`) produces a signal
	// instead of silently doing nothing. The recognized set is single-sourced
	// (#883): the project loader's own keys + the project-scoped flag sections
	// (registry-derived) + the foreign namespaces the LSP loader reads from this
	// same file. A key recognized ONLY at global scope (e.g. `lsp`, `tests`,
	// `delta`) gets a distinct, honest signal that it does nothing here rather
	// than being lumped in with typos — docs previously called this "silently
	// ignored".
	const knownProjectKeys = new Set<string>([
		...PROJECT_NON_FLAG_CONFIG_SECTIONS,
		...flagConfigSectionKeys(PROJECT_SCOPED_LENS_FLAGS),
		...PROJECT_FOREIGN_CONFIG_NAMESPACES,
	]);
	const globalScopeOnlyKeys = new Set<string>(
		[
			...flagConfigSectionKeys(LENS_FLAGS),
			...GLOBAL_NON_FLAG_CONFIG_SECTIONS,
		].filter((key) => !knownProjectKeys.has(key)),
	);
	// The full DOTTED config keys of the flags a project file cannot set, for the
	// sub-key scan below. Section-level keys are too coarse for a namespace that
	// mixes scopes: `lsp` holds four project-scoped settings AND the global-only
	// `lsp.enabled`.
	const projectScoped = new Set<string>(
		PROJECT_SCOPED_LENS_FLAGS.map((spec) => spec.configKey),
	);
	const globalScopeOnlyFlagKeys = LENS_FLAGS.map(
		(spec) => spec.configKey,
	).filter((configKey) => !projectScoped.has(configKey));
	// The literal path is derived, not hand-typed (#2426 review round 3, S1):
	// under `PI_LENS_CONFIG_PATH` the canonical global config is NOT
	// `~/.pi-lens/config.json`, and a hardcoded string in this notice would name
	// a file the resolver never reads.
	const globalConfigLabel = homeRelativePath(
		getPiLensGlobalConfigPath(),
		os.homedir(),
	);
	const warnUnhonoredKey = (label: string, globalOnly: boolean): void => {
		note(
			globalOnly
				? `"${label}" is a global-only pi-lens setting and is not honored in a project .pi-lens.json (set it in ${globalConfigLabel} or pass the matching CLI flag); ignored`
				: `unknown key "${label}" is not a recognized pi-lens setting (check for a typo); ignored`,
		);
	};
	for (const key of Object.keys(obj)) {
		if (knownProjectKeys.has(key)) continue;
		warnUnhonoredKey(key, globalScopeOnlyKeys.has(key));
	}

	// A tolerated foreign namespace is tolerated KEY BY KEY (#2426 review round
	// 2, F3). `lsp` is read out of this file by the LSP loader, but only four of
	// its keys are project-scoped; `lsp.enabled` is the `--no-lsp` flag, which is
	// `scope: "global"`. Blanket namespace tolerance swallowed it silently, which
	// `docs/configuration.md`'s "nothing is ignored silently" forbids — so every
	// other sub-key gets the same global-only-vs-typo signal a top-level key does,
	// named with its DOTTED path so the notice says which setting is meant.
	for (const [namespace, honored] of PROJECT_FOREIGN_NAMESPACE_HONORED_KEYS) {
		const section = obj[namespace];
		if (!section || typeof section !== "object" || Array.isArray(section)) {
			continue;
		}
		for (const key of Object.keys(section as Record<string, unknown>)) {
			if (honored.includes(key)) continue;
			const dotted = `${namespace}.${key}`;
			warnUnhonoredKey(
				dotted,
				globalScopeOnlyFlagKeys.some(
					(configKey) =>
						configKey === dotted || configKey.startsWith(`${dotted}.`),
				),
			);
		}
	}

	return {
		config: {
			ignore,
			rules,
			...(mutations as Pick<
				PiLensProjectConfig,
				"format" | "autofix" | "actionableWarnings"
			>),
			maxProjectFiles,
			reviewGraph,
			raw,
			configPath,
		},
		records: resolved.records,
		ignored: ignoredRecords(),
	};
}
