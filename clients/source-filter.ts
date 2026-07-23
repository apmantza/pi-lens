/**
 * Source File Filter — Deduplicates source files by detecting build artifacts.
 *
 * Problem: When scanning a codebase, we encounter both source files and their
 * compiled/transpiled outputs (TypeScript → JavaScript, Vue → JavaScript, etc.).
 * Scanning both wastes time and produces duplicate findings.
 *
 * Solution: For each file, check if a "higher precedence" source sibling exists.
 * If yes, skip the file as a build artifact. If no, keep it as hand-written source.
 *
 * Supported ecosystems:
 * - TypeScript: .ts shadows .js, .tsx shadows .jsx
 * - Vue/Svelte: .vue/.svelte shadows .js
 * - CoffeeScript: .coffee shadows .js
 *
 * Files without higher-precedence siblings are kept only when they do not look
 * generated/codegen-produced (hand-written JS, Python, Go, Rust, etc.).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectIgnoreMatcher } from "./file-utils.js";
import {
	isDeclarationFile,
	isGeneratedOrArtifact,
} from "./generated-artifacts.js";
import { normalizeEphemeralMapKey } from "./path-utils.js";
import { isSlowFs, SLOW_FS_REDUCED_MAX_FILES } from "./slow-fs.js";
import {
	shouldRecurseIntoDir,
	walkTreeRecursiveSync,
	walkTreeStackAsync,
} from "./source-walker.js";

/**
 * Per-walk memo of sibling-existence probe results (refs #191, item 1).
 *
 * `findSourceSibling` / `isBuildArtifact` probe for a "higher precedence"
 * source sibling (e.g. does `foo.ts` exist next to `foo.js`?) via
 * `fs.existsSync`. Enumerating a directory with many files of the same
 * basename family (e.g. `foo.js`, `foo.test.js`, `foo.spec.js` all probing for
 * `foo.ts`) or many files that all fail the same probe re-issues identical
 * `existsSync` calls.
 *
 * This cache is intentionally scoped to a single walk (created at the start of
 * one `collectSourceFiles`/`collectSourceFilesAsync` call and discarded when
 * it returns). A walk is a point-in-time filesystem snapshot, so caching
 * within it needs no invalidation by construction — there is no persistent,
 * module-global cache here, and none should be added: siblings can change
 * between walks, and a stale persistent cache risks silently misclassifying a
 * file (lost detection), which is exactly why issue #191 deferred a
 * persistent version. Callers that don't pass a cache get exactly today's
 * behavior (fail-safe default of "probe every time").
 *
 * Keyed via {@link normalizeEphemeralMapKey} — the cheap, syntactic-only
 * sibling of `normalizeMapKey` (no `realpathSync`) — so lookups are
 * separator/case-consistent on Windows without paying a filesystem round
 * trip just to compute the key. Using the full `normalizeMapKey` here would
 * be actively counterproductive: for a candidate sibling path that does not
 * exist (the common case), it resolves the nearest existing ancestor via its
 * own `existsSync` walk, which measured ~11x slower than the single
 * `existsSync` probe this cache exists to avoid (refs #191). This cache's
 * keys are produced by this process's own `path.join` calls within a single
 * walk, so the cheap fold is safe here — see `normalizeEphemeralMapKey`'s
 * docstring for when it is NOT safe to reuse elsewhere.
 */
export type ArtifactProbeCache = Map<string, boolean>;

/**
 * Create a fresh, empty per-walk probe cache. Callers that enumerate many
 * files (a single `collectSourceFiles`/`collectSourceFilesAsync` invocation)
 * should create one of these at the start of the walk and pass it through;
 * it must not be reused across separate walks.
 */
export function createArtifactProbeCache(): ArtifactProbeCache {
	return new Map();
}

function probeExists(filePath: string, cache?: ArtifactProbeCache): boolean {
	if (!cache) return fs.existsSync(filePath);
	const key = normalizeEphemeralMapKey(filePath);
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const result = fs.existsSync(filePath);
	cache.set(key, result);
	return result;
}

/**
 * Mapping of file extension to the extensions it shadows (build artifacts).
 * Order matters: first entry has highest precedence.
 */
export const SOURCE_PRECEDENCE: Record<string, string[]> = {
	".ts": [".js", ".mjs", ".cjs"],
	".tsx": [".jsx", ".js", ".mjs", ".cjs"],
	".vue": [".js", ".mjs"],
	".svelte": [".js", ".mjs"],
	".coffee": [".js"],
};

/**
 * All extensions that could be source or artifacts, in precedence order.
 */
export const ALL_SCANNABLE_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".vue",
	".svelte",
	".coffee",
	".py",
	".go",
	".rs",
	".rb",
	".rake",
	".gemspec",
	".ru",
];

/**
 * Structural safety net for the source-file walk (#250/#747 escape class).
 *
 * `maxFiles` is optional, and historically an omitted cap meant an UNBOUNDED
 * traversal — so any caller that forgot to pass one could, from a misrooted cwd
 * (e.g. one that climbed to $HOME), enumerate the entire home tree before it
 * ever decided to bail. This finite default caps that walk regardless of what
 * the caller asked for: no caller can trigger an unbounded collection just by
 * omitting `maxFiles`. Deliberately generous — real projects are far under it,
 * so it never trims a legitimate scan; it only exists to bound the pathological
 * misrooted case. A caller that genuinely needs more must pass an explicit
 * larger `maxFiles`.
 */
export const DEFAULT_MAX_SOURCE_FILES = 20000;

/**
 * Entry-visit budget for the collect walks (#760, the #758 escape class).
 *
 * `maxFiles` caps results FOUND, not entries VISITED — so a mixed tree with
 * few source files but a huge pile of non-source files (reporter's case: ~300
 * scripts among ~84k game-mod data files) never trips it and still gets a
 * full-tree walk, dominated by one `ignoreMatcher.isIgnored()` call per entry.
 * This budget counts every directory entry the walk touches — including
 * ignored/skipped ones, because the per-entry ignore probe IS the dominant
 * cost — and stops the walk when exhausted, returning the best-effort list
 * collected so far.
 *
 * 200k is deliberately generous: at the ~25µs/entry ignore-probe cost that
 * motivated #758 it bounds the worst case to a few seconds instead of an
 * unbounded multi-minute walk over a misrooted ($HOME-scale) or
 * data-dominated tree, while staying an order of magnitude above any healthy
 * project's entry count — so real repos never see a truncated list. Callers
 * that need a tighter bound pass `maxScanEntries` explicitly.
 *
 * #776 note: deliberately NOT derived from `project-scale.ts`'s
 * `maxProjectFiles` knob, unlike the five file-count budgets it unifies. This
 * is a directory-ENTRIES-visited safety valve, not a source-files-kept
 * budget — the two units don't scale together (a repo with a huge
 * non-source data/asset tree needs a much larger entries budget than its
 * file count would suggest), so coupling them risks changing behavior on
 * exactly the pathological-tree shapes this ceiling protects. See
 * `project-scale.ts`'s file header for the full rationale.
 */
export const DEFAULT_MAX_SCAN_ENTRIES = 200_000;

export interface SourceCollectionOptions {
	/** Additional directory names to exclude (merged with defaults) */
	excludeDirs?: string[];
	/** File extensions to consider (defaults to ALL_SCANNABLE_EXTENSIONS) */
	extensions?: string[];
	/** Whether to follow symlinks (default: false) */
	followSymlinks?: boolean;
	/** Keep generated/codegen files instead of filtering them (default: false) */
	includeGenerated?: boolean;
	/** Keep declaration stubs such as .d.ts (default: false) */
	includeDeclarationFiles?: boolean;
	/** Inspect a small header prefix for generated-code banners (default: true) */
	inspectGeneratedHeaders?: boolean;
	/**
	 * Hard cap on the number of source files collected. When set, the walk stops
	 * as soon as this many files are kept — so an over-broad root (e.g. one that
	 * climbed to $HOME) can't enumerate the whole tree before a caller decides to
	 * bail on count. Callers that only need "are there more than N?" should pass
	 * `N + 1`. Unset = {@link DEFAULT_MAX_SOURCE_FILES} (a finite structural cap,
	 * never unbounded). Refs #250/#747.
	 */
	maxFiles?: number;
	/**
	 * Budget on directory entries VISITED (including ignored/skipped ones) —
	 * independent of the `maxFiles` results cap, exactly as in #758: `maxFiles`
	 * bounds what the walk keeps, this bounds the work it does to find it. When
	 * exhausted the walk stops and returns the files collected so far. Unset =
	 * {@link DEFAULT_MAX_SCAN_ENTRIES} (finite, never unbounded). Named
	 * consistently with startup-scan's entry budget. Refs #760.
	 */
	maxScanEntries?: number;
}

/**
 * Result of a budget-aware collect walk (#760). `files` is the same list the
 * plain collectors return; `entryBudgetExceeded` is true when the walk stopped
 * because it visited `maxScanEntries` directory entries — the list is then a
 * truncated best-effort view of the tree, not a complete enumeration.
 */
export interface SourceCollectionResult {
	files: string[];
	entryBudgetExceeded: boolean;
}

function shouldSkipGeneratedOrArtifact(
	filePath: string,
	options?: Pick<
		SourceCollectionOptions,
		"includeGenerated" | "includeDeclarationFiles" | "inspectGeneratedHeaders"
	>,
): boolean {
	const includeDeclarations = options?.includeDeclarationFiles === true;
	if (options?.includeGenerated === true) {
		return !includeDeclarations && isDeclarationFile(filePath);
	}

	return isGeneratedOrArtifact(filePath, {
		readContentHeader: options?.inspectGeneratedHeaders !== false,
		includeDeclarations: !includeDeclarations,
	});
}

/**
 * Extract the basename (filename without extension) from a path.
 */
function getBasename(filePath: string): string {
	const ext = path.extname(filePath);
	return path.basename(filePath, ext);
}

/**
 * Get the directory of a file path.
 */
function getDir(filePath: string): string {
	return path.dirname(filePath);
}

/**
 * Check if a file has a higher-precedence source sibling.
 * Returns the shadowing source file path if found, null otherwise.
 */
export function findSourceSibling(
	filePath: string,
	probeCache?: ArtifactProbeCache,
): string | null {
	const ext = path.extname(filePath).toLowerCase();
	const dir = getDir(filePath);
	const base = getBasename(filePath);

	// Find which precedence group this extension belongs to
	for (const [sourceExt, shadowedExts] of Object.entries(SOURCE_PRECEDENCE)) {
		if (shadowedExts.includes(ext)) {
			// This file could be shadowed by a source file with sourceExt
			const siblingPath = path.join(dir, base + sourceExt);
			if (probeExists(siblingPath, probeCache)) {
				return siblingPath;
			}
		}
	}

	return null;
}

/**
 * Check if a file is a build artifact (has a source sibling).
 *
 * @param probeCache - Optional per-walk memo (see {@link ArtifactProbeCache}).
 * Omit for the original, uncached behavior.
 */
export function isBuildArtifact(
	filePath: string,
	probeCache?: ArtifactProbeCache,
): boolean {
	return findSourceSibling(filePath, probeCache) !== null;
}

/**
 * Filter a list of files, removing build artifacts that have source siblings
 * plus likely generated/codegen artifacts.
 * Returns de-duplicated list keeping only highest-precedence source files.
 */
export function filterSourceFiles(
	filePaths: string[],
	options?: Pick<
		SourceCollectionOptions,
		"includeGenerated" | "includeDeclarationFiles" | "inspectGeneratedHeaders"
	>,
): string[] {
	// Track which files we're keeping and why we're skipping others
	const keep: string[] = [];
	const skipReasons = new Map<string, string>(); // skipped file -> kept source
	// This is itself one enumeration over `filePaths`, so a per-call memo is
	// safe by the same point-in-time-snapshot reasoning as the directory
	// walkers below (refs #191).
	const probeCache = createArtifactProbeCache();

	for (const filePath of filePaths) {
		const sourceSibling = findSourceSibling(filePath, probeCache);
		if (sourceSibling) {
			// This is a build artifact, skip it
			skipReasons.set(filePath, sourceSibling);
		} else if (shouldSkipGeneratedOrArtifact(filePath, options)) {
			// Generated/codegen outputs are not hand-written source.
			skipReasons.set(filePath, "generated-or-artifact");
		} else {
			// No higher-precedence source, keep it
			keep.push(filePath);
		}
	}

	return keep;
}

/**
 * Recursively collect all source files in a directory, excluding build artifacts
 * and likely generated/codegen artifacts.
 *
 * @param dir - Directory to scan
 * @param options - Optional configuration
 * @returns Array of absolute file paths that are source files (not artifacts)
 */
interface ResolvedCollectionConfig {
	ignoreMatcher: ReturnType<typeof getProjectIgnoreMatcher>;
	extraExcludePatterns: string[];
	extensions: Set<string>;
	maxFiles: number;
	maxScanEntries: number;
	options?: SourceCollectionOptions;
}

/**
 * Coerce a caller-supplied cap to a finite positive integer, falling back to
 * the module default — omitted / non-finite / non-positive means the FINITE
 * default, never `Infinity` (#250/#747/#760: an unbounded walk was the bug).
 */
function resolveFiniteCap(raw: number | undefined, fallback: number): number {
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0
		? Math.floor(raw)
		: fallback;
}

function resolveCollectionConfig(
	rootDir: string,
	options?: SourceCollectionOptions,
	config?: { clampForSlowFsSyncWalk?: boolean },
): ResolvedCollectionConfig {
	const requestedMax = resolveFiniteCap(
		options?.maxFiles,
		DEFAULT_MAX_SOURCE_FILES,
	);
	// Slow-FS mode (#462): the sync collector can't yield to the event loop, so
	// on a measured-slow filesystem (9p/drvfs/NFS) clamp its walk to a much
	// smaller cap regardless of what the caller asked for. The async twin
	// (`collectSourceFilesAsync`) yields every N entries and keeps its normal
	// cap — callers that can go async should prefer it instead of relying on
	// this clamp.
	const maxFiles =
		config?.clampForSlowFsSyncWalk === true && isSlowFs(rootDir)
			? Math.min(requestedMax, SLOW_FS_REDUCED_MAX_FILES)
			: requestedMax;
	return {
		ignoreMatcher: getProjectIgnoreMatcher(rootDir),
		extraExcludePatterns: options?.excludeDirs ?? [],
		extensions: new Set(options?.extensions || ALL_SCANNABLE_EXTENSIONS),
		maxFiles,
		maxScanEntries: resolveFiniteCap(
			options?.maxScanEntries,
			DEFAULT_MAX_SCAN_ENTRIES,
		),
		options,
	};
}

/**
 * Decide how to handle a single directory entry. Returns the subdirectory to
 * recurse into (`recurseInto`), the source file to keep (`keepFile`), or
 * neither (skip). Shared verbatim by the sync and async collectors so they
 * produce identical results — the only difference between the two is that the
 * async variant yields to the event loop every N entries.
 */
function classifyEntry(
	entry: fs.Dirent,
	fullPath: string,
	cfg: ResolvedCollectionConfig,
	probeCache?: ArtifactProbeCache,
): { recurseInto?: string; keepFile?: string } {
	const { ignoreMatcher, extraExcludePatterns, extensions, options } = cfg;
	if (entry.isDirectory()) {
		const canRecurse = shouldRecurseIntoDir(entry, fullPath, {
			ignoreMatcher,
			extraExcludeDirs: extraExcludePatterns,
			skipGeneratedArtifactDirs: options?.includeGenerated !== true,
			followSymlinks: options?.followSymlinks === true,
		});
		if (!canRecurse) return {};
		return { recurseInto: fullPath };
	}
	if (entry.isFile()) {
		if (ignoreMatcher.isIgnored(fullPath, false)) return {};
		const ext = path.extname(entry.name).toLowerCase();
		if (!extensions.has(ext)) return {};
		// Skip if this is a build artifact or generated/codegen output.
		if (isBuildArtifact(fullPath, probeCache)) return {};
		if (shouldSkipGeneratedOrArtifact(fullPath, options)) return {};
		return { keepFile: fullPath };
	}
	return {};
}

/**
 * Mutable per-walk visited-entry counter (#760). Shared verbatim by the sync
 * and async collectors (like `classifyEntry`) so both charge the budget
 * identically: one tick per directory entry TOUCHED — before the entry is
 * classified, so ignored/skipped entries count too (the per-entry ignore probe
 * is the dominant cost the budget exists to bound).
 */
interface EntryBudget {
	visited: number;
	limit: number;
	exceeded: boolean;
}

function createEntryBudget(limit: number): EntryBudget {
	return { visited: 0, limit, exceeded: false };
}

/**
 * Charge one visited entry against the budget. Returns false — permanently,
 * once tripped — when the walk must stop.
 */
function chargeEntryBudget(budget: EntryBudget): boolean {
	if (budget.exceeded) return false;
	budget.visited += 1;
	if (budget.visited > budget.limit) budget.exceeded = true;
	return !budget.exceeded;
}

/**
 * Budget-aware core of {@link collectSourceFiles} (#760). Same walk, same
 * list — plus `entryBudgetExceeded` so callers can tell a complete
 * enumeration from a truncated best-effort one. The plain collector wraps
 * this, keeping the existing `string[]` return contract intact.
 */
export function collectSourceFilesWithBudget(
	dir: string,
	options?: SourceCollectionOptions,
): SourceCollectionResult {
	const rootDir = path.resolve(dir);
	const cfg = resolveCollectionConfig(rootDir, options, {
		clampForSlowFsSyncWalk: true,
	});
	const files: string[] = [];
	// Per-walk sibling-probe memo (refs #191, item 1). Created here, discarded
	// on return — never persisted across calls.
	const probeCache = createArtifactProbeCache();
	const budget = createEntryBudget(cfg.maxScanEntries);

	// #761: immediate-descent recursion driver (result-array order preserved),
	// with both caps kept as this walker's own per-entry policy: the hard
	// `maxFiles` results cap (#250) is checked BEFORE charging the entry budget
	// (#760), and a file that reaches `maxFiles` is the last one kept — the cap
	// then trips on the following entry, matching the pre-#761 loop exactly.
	walkTreeRecursiveSync(rootDir, (entry, fullPath) => {
		if (files.length >= cfg.maxFiles) return "stop"; // hard cap (#250)
		if (!chargeEntryBudget(budget)) return "stop"; // entry budget (#760)
		const { recurseInto, keepFile } = classifyEntry(
			entry,
			fullPath,
			cfg,
			probeCache,
		);
		if (recurseInto) return "recurse";
		if (keepFile) files.push(keepFile);
		return "skip";
	});
	return { files, entryBudgetExceeded: budget.exceeded };
}

export function collectSourceFiles(
	dir: string,
	options?: SourceCollectionOptions,
): string[] {
	return collectSourceFilesWithBudget(dir, options).files;
}

/**
 * Async, chunked-yield twin of {@link collectSourceFiles}. Returns the exact
 * same file list (it shares `classifyEntry`), but yields to the event loop
 * every `yieldEvery` directory entries so a large tree never holds the loop in
 * one synchronous burst.
 *
 * Why this exists: on a ~2k-file project the synchronous `collectSourceFiles`
 * blocks the loop for ~1.5s on a cold scan (≈70% of that is the per-file
 * generated-header read inside `shouldSkipGeneratedOrArtifact`). When that runs
 * on a hook tick — even a deferred background one — pi's TUI input stalls for
 * the whole burst. Background / deferred callers should prefer this variant;
 * the sync version is kept for synchronous call sites and tests.
 */
export async function collectSourceFilesAsync(
	dir: string,
	options?: SourceCollectionOptions & { yieldEvery?: number },
): Promise<string[]> {
	return (await collectSourceFilesWithBudgetAsync(dir, options)).files;
}

/**
 * Budget-aware core of {@link collectSourceFilesAsync} (#760) — the async twin
 * of {@link collectSourceFilesWithBudget}, with the same
 * `entryBudgetExceeded` contract.
 */
export async function collectSourceFilesWithBudgetAsync(
	dir: string,
	options?: SourceCollectionOptions & { yieldEvery?: number },
): Promise<SourceCollectionResult> {
	const rootDir = path.resolve(dir);
	const cfg = resolveCollectionConfig(rootDir, options);
	const files: string[] = [];
	// Per-walk sibling-probe memo (refs #191, item 1). A single async walk is
	// still one point-in-time snapshot despite yielding between chunks, so
	// caching across the whole call remains invalidation-free.
	const probeCache = createArtifactProbeCache();
	const budget = createEntryBudget(cfg.maxScanEntries);

	// #761: shared depth-first stack driver (its reverse-push mirrors the sync
	// collector's left-to-right recursion). The async collector charges the
	// entry budget (#760) FIRST, then checks the `maxFiles` cap immediately
	// after keeping a file — subtly different from the sync collector's ordering
	// but preserved verbatim, so both stay byte-identical to their pre-#761 form.
	await walkTreeStackAsync(
		rootDir,
		(entry, fullPath) => {
			if (!chargeEntryBudget(budget)) return "stop"; // entry budget (#760)
			const { recurseInto, keepFile } = classifyEntry(
				entry,
				fullPath,
				cfg,
				probeCache,
			);
			if (recurseInto) return "recurse";
			if (keepFile) {
				files.push(keepFile);
				if (files.length >= cfg.maxFiles) return "stop"; // hard cap (#250)
			}
			return "skip";
		},
		{
			// 50 entries/chunk keeps the worst-case synchronous burst under ~40ms
			// even on a cold scan where every kept file pays the 4 KB generated-
			// header read (measured on a 2k-file fixture). Larger values regress
			// past the ~50ms event-loop budget; see PERF-AUDIT.md.
			yieldEvery: Math.max(1, options?.yieldEvery ?? 50),
			// #703: prime the tracked-files set once before the walk so a tracked
			// file matching a `.gitignore`/global pattern still surfaces. Fail-open
			// on no-git/spawn failure.
			beforeWalk: () => cfg.ignoreMatcher.ensureTrackedIndex(),
		},
	);

	return { files, entryBudgetExceeded: budget.exceeded };
}

/**
 * Get statistics about source file filtering for debugging/monitoring.
 */
export function getFilterStats(
	allFiles: string[],
	filteredFiles: string[],
): {
	total: number;
	kept: number;
	skipped: number;
	byType: Record<string, number>;
} {
	const skipped = allFiles.length - filteredFiles.length;
	const byType: Record<string, number> = {};

	// Count what we skipped
	for (const file of allFiles) {
		if (!filteredFiles.includes(file)) {
			const ext = path.extname(file).toLowerCase();
			byType[ext] = (byType[ext] || 0) + 1;
		}
	}

	return {
		total: allFiles.length,
		kept: filteredFiles.length,
		skipped,
		byType,
	};
}
