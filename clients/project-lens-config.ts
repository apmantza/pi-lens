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
 * The file is loaded once per `(path, mtimeMs)` and cached — editing the file
 * invalidates the cache so the next access sees the new values without
 * restarting pi. Caller (currently `applyProjectLensConfig` in
 * `dispatch/integration.ts`) is responsible for translating the parsed values
 * into the relevant setters; this module is intentionally only a parser.
 *
 * The loader walks up from the starting directory until it finds a config file
 * (mirroring `lsp/config.ts`'s `loadLSPConfig` so project-monorepos with a
 * `.pi-lens.json` at the repo root work without per-subdir configs).
 *
 * A malformed file is silently treated as "no config" — we never want a stray
 * syntax error in user-edited JSON to break diagnostics.
 */
import * as fs from "node:fs";
import * as path from "node:path";

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
	/** The parsed JSON as-is, for forward-compat consumers. */
	raw: unknown;
	/** Absolute path of the config file that was loaded, or undefined if none. */
	configPath: string | undefined;
	/** Directory containing the config file, or undefined if none was loaded. */
	configDir: string | undefined;
}

export const EMPTY_PROJECT_CONFIG: PiLensProjectConfig = {
	ignore: [],
	rules: {},
	raw: undefined,
	configPath: undefined,
	configDir: undefined,
};

interface CacheEntry {
	mtimeMs: number;
	config: PiLensProjectConfig;
}

/** Cache by absolute config path; we read each candidate's mtime before reuse. */
const configCache = new Map<string, CacheEntry>();

/**
 * Walk up from `startDir` looking for a `.pi-lens.json` or `pi-lens.json`.
 * Returns the parsed config, or an empty config if none was found.
 */
export function loadPiLensProjectConfig(startDir: string): PiLensProjectConfig {
	const configInfo = findPiLensProjectConfig(startDir);
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
}

export interface PiLensProjectConfigFileInfo {
	path: string;
	dir: string;
	mtimeMs: number;
}

export function findPiLensProjectConfig(
	startDir: string,
): PiLensProjectConfigFileInfo | undefined {
	let dir = path.resolve(startDir);
	while (true) {
		for (const name of PROJECT_CONFIG_BASENAMES) {
			const candidate = path.join(dir, name);
			try {
				const stat = fs.statSync(candidate);
				if (stat.isFile()) {
					return { path: candidate, dir, mtimeMs: stat.mtimeMs };
				}
			} catch {
				// not present; keep walking
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined; // reached fs root
		dir = parent;
	}
}

function parseConfigFile(configPath: string): PiLensProjectConfig {
	let raw: unknown;
	try {
		const text = fs.readFileSync(configPath, "utf-8");
		raw = JSON.parse(text);
	} catch {
		return EMPTY_PROJECT_CONFIG;
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
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
			}
		}
	}

	return { ignore, rules, raw, configPath, configDir: path.dirname(configPath) };
}
