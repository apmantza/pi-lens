/**
 * Project-level `.pi-lens.json` config loader.
 *
 * Reads an optional `.pi-lens.json` (or `pi-lens.json`) at the project root and
 * surfaces two fields the rest of pi-lens now honors:
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
import * as fs from "node:fs";
import * as path from "node:path";
import { walkUpDirs } from "./path-utils.js";

const PROJECT_CONFIG_BASENAMES = [".pi-lens.json", "pi-lens.json"];

export interface PiLensProjectRuleConfig {
	/** Optional override for the rule's primary numeric threshold. */
	threshold?: number;
}

export interface PiLensProjectConfig {
	/** gitignore-style glob patterns added to every diagnostic scan. */
	ignore: string[];
	/** Per-rule threshold overrides; missing keys mean "use hardcoded default". */
	rules: Record<string, PiLensProjectRuleConfig>;
	/**
	 * Base project-size scale knob (#776) — see `clients/project-scale.ts`.
	 * `undefined` means "use the env override / default chain".
	 */
	maxProjectFiles: number | undefined;
	/** The parsed JSON as-is, for forward-compat consumers. */
	raw: unknown;
	/** Absolute path of the config file that was loaded, or undefined if none. */
	configPath: string | undefined;
}

export const EMPTY_PROJECT_CONFIG: PiLensProjectConfig = {
	ignore: [],
	rules: {},
	maxProjectFiles: undefined,
	raw: undefined,
	configPath: undefined,
};

interface CacheEntry {
	mtimeMs: number;
	config: PiLensProjectConfig;
}

interface DiscoveryCacheEntry {
	info: PiLensProjectConfigFileInfo | undefined;
	dirMtimes: Array<{ dir: string; mtimeMs: number }>;
}

/** Cache by absolute config path; we read each candidate's mtime before reuse. */
const configCache = new Map<string, CacheEntry>();
const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const warnedInvalidConfigs = new Set<string>();

/**
 * Walk up from `startDir` looking for a `.pi-lens.json` or `pi-lens.json`.
 * Returns the parsed config, or an empty config if none was found.
 */
export function loadPiLensProjectConfig(
	startDir: string,
	preloadedInfo = findPiLensProjectConfig(startDir),
): PiLensProjectConfig {
	const configInfo = preloadedInfo;
	if (!configInfo) return EMPTY_PROJECT_CONFIG;

	const cached = configCache.get(configInfo.path);
	if (cached && cached.mtimeMs === configInfo.mtimeMs) {
		return cached.config;
	}

	const config = parseConfigFile(configInfo.path);
	configCache.set(configInfo.path, { mtimeMs: configInfo.mtimeMs, config });
	return config;
}

/** For tests + callers that need to force a re-read (e.g. config-watcher hooks). */
export function resetProjectLensConfigCache(): void {
	configCache.clear();
	discoveryCache.clear();
	warnedInvalidConfigs.clear();
}

export interface PiLensProjectConfigFileInfo {
	path: string;
	dir: string;
	mtimeMs: number;
}

/**
 * Look for a `.pi-lens.json`/`pi-lens.json` directly IN `dir` — no upward
 * walk. Used to layer nested per-package configs (#783) the same way
 * `file-utils.ts` layers nested `.gitignore`s: each ancestor directory
 * between the git root and a target file is checked for its OWN config
 * file, independent of whatever config `loadPiLensProjectConfig`'s upward
 * walk would find starting from `dir`.
 */
export function findPiLensConfigInDir(
	dir: string,
): PiLensProjectConfigFileInfo | undefined {
	for (const name of PROJECT_CONFIG_BASENAMES) {
		const candidate = path.join(dir, name);
		const stat = safeFileStat(candidate);
		if (stat?.isFile()) return { path: candidate, dir, mtimeMs: stat.mtimeMs };
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

	const cached = configCache.get(info.path);
	if (cached && cached.mtimeMs === info.mtimeMs) {
		return cached.config;
	}

	const config = parseConfigFile(info.path);
	configCache.set(info.path, { mtimeMs: info.mtimeMs, config });
	return config;
}

export function findPiLensProjectConfig(
	startDir: string,
): PiLensProjectConfigFileInfo | undefined {
	const cacheKey = path.resolve(startDir);
	const cached = discoveryCache.get(cacheKey);
	if (cached && discoveryCacheStillFresh(cached)) {
		if (!cached.info) return undefined;
		const stat = safeFileStat(cached.info.path);
		if (stat?.isFile()) return { ...cached.info, mtimeMs: stat.mtimeMs };
	}

	const discovered = discoverPiLensProjectConfig(cacheKey);
	discoveryCache.set(cacheKey, discovered);
	return discovered.info;
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
	return entry.dirMtimes.every(
		(cached) => safeDirMtimeMs(cached.dir) === cached.mtimeMs,
	);
}

function discoverPiLensProjectConfig(startDir: string): DiscoveryCacheEntry {
	const dirMtimes: Array<{ dir: string; mtimeMs: number }> = [];
	for (const dir of walkUpDirs(startDir)) {
		dirMtimes.push({ dir, mtimeMs: safeDirMtimeMs(dir) });
		for (const name of PROJECT_CONFIG_BASENAMES) {
			const candidate = path.join(dir, name);
			const stat = safeFileStat(candidate);
			if (stat?.isFile()) {
				return {
					info: { path: candidate, dir, mtimeMs: stat.mtimeMs },
					dirMtimes,
				};
			}
		}
	}
	return { info: undefined, dirMtimes };
}

function warnInvalidConfigOnce(configPath: string, reason: string): void {
	const key = `${configPath}:${reason}`;
	if (warnedInvalidConfigs.has(key)) return;
	warnedInvalidConfigs.add(key);
	console.error(
		`[pi-lens] ignoring invalid project config ${configPath}: ${reason}`,
	);
}

function parseConfigFile(configPath: string): PiLensProjectConfig {
	let raw: unknown;
	try {
		const text = fs.readFileSync(configPath, "utf-8");
		raw = JSON.parse(text);
	} catch (error) {
		warnInvalidConfigOnce(
			configPath,
			error instanceof Error ? error.message : "failed to parse JSON",
		);
		return EMPTY_PROJECT_CONFIG;
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		warnInvalidConfigOnce(configPath, "top-level value must be an object");
		return EMPTY_PROJECT_CONFIG;
	}

	const obj = raw as Record<string, unknown>;

	const ignore = Array.isArray(obj.ignore)
		? obj.ignore.filter((p): p is string => typeof p === "string")
		: [];

	const rules: Record<string, PiLensProjectRuleConfig> = {};
	if (obj.rules && typeof obj.rules === "object" && !Array.isArray(obj.rules)) {
		const rawRules = obj.rules as Record<string, unknown>;
		for (const [ruleId, ruleCfg] of Object.entries(rawRules)) {
			if (!ruleCfg || typeof ruleCfg !== "object" || Array.isArray(ruleCfg)) {
				continue;
			}
			const r = ruleCfg as Record<string, unknown>;
			if (
				typeof r.threshold === "number" &&
				Number.isFinite(r.threshold) &&
				r.threshold > 0
			) {
				rules[ruleId] = { threshold: r.threshold };
			} else if ("threshold" in r) {
				warnInvalidConfigOnce(
					configPath,
					`rules.${ruleId}.threshold must be a positive finite number`,
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
			warnInvalidConfigOnce(
				configPath,
				"maxProjectFiles must be a positive finite number",
			);
		}
	}

	return { ignore, rules, maxProjectFiles, raw, configPath };
}
