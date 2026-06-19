/**
 * Shared file path utilities for pi-lens
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { minimatch } from "minimatch";
import {
	getGlobalIgnorePatterns,
	getPiLensGlobalConfigPath,
} from "./lens-config.js";
import { normalizeFilePath } from "./path-utils.js";
import {
	findPiLensProjectConfig,
	loadPiLensProjectConfig,
} from "./project-lens-config.js";
import { safeSpawnAsync } from "./safe-spawn.js";

/**
 * Return the directory where pi-lens stores project-specific data
 * (caches, indexes, worklogs, etc.).
 *
 * Default: reuse <project>/.pi-lens if it already exists, otherwise use
 * ~/.pi-lens/projects/<project-slug>
 *
 * Override: set PILENS_DATA_DIR=/some/path — each project gets its own
 * subdirectory named after a sanitized form of its absolute path, e.g.
 *   PILENS_DATA_DIR=~/.pi-lens/projects
 *   → ~/.pi-lens/projects/home-user-myapp/
 *
 * This keeps project folders clean and avoids creating .pi-lens folders
 * inside user projects.
 */
export function getProjectDataDir(cwd: string): string {
	const legacyProjectDir = path.join(cwd, ".pi-lens");
	const configuredBase = process.env.PILENS_DATA_DIR?.trim();
	if (!configuredBase && fs.existsSync(legacyProjectDir)) {
		return legacyProjectDir;
	}
	const base =
		configuredBase || path.join(os.homedir(), ".pi-lens", "projects");
	const normalized = normalizeFilePath(path.resolve(cwd));
	const slug = normalized
		.replace(/^[a-z]:/i, "") // strip Windows drive letter
		.replace(/\/+/g, "-") // separators → dashes
		.replace(/[^A-Za-z0-9-]/g, "") // strip anything else
		.replace(/^-+/, "") // trim leading dashes
		.replace(/-+$/, ""); // trim trailing dashes
	return path.join(base.trim(), slug || "default");
}

/**
 * Machine-global pi-lens directory: `~/.pi-lens/`.
 *
 * Used for logs (latency, cascade, read-guard, tree-sitter, actionable-warnings,
 * sessionstart), tool binaries (`~/.pi-lens/tools/`, `~/.pi-lens/bin/`), LSP
 * server storage, and other state that is intentionally NOT project-scoped
 * — it spans every project pi-lens has touched.
 *
 * Distinct from `getProjectDataDir(cwd)`, which respects `PILENS_DATA_DIR`
 * and produces per-project subdirectories. Callers writing project caches,
 * snapshots, or worklogs should use `getProjectDataDir(cwd)` instead.
 */
export function getGlobalPiLensDir(): string {
	return path.join(os.homedir(), ".pi-lens");
}

/**
 * Directories to exclude from all scans (build outputs, dependencies, caches).
 * Used consistently across all scanners to avoid noise from generated files.
 */
export const EXCLUDED_DIRS = [
	"node_modules",
	".git",
	"dist",
	"build",
	".turbo",
	".cache",
	"target",
	"out",
	".parcel-cache",
	".svelte-kit",
	".nuxt",
	".yarn",
	".pnpm-store",
	".gradle",
	".next",
	".pi-lens",
	".pi", // pi agent directory
	".ruff_cache", // Python linter cache
	".worktrees",
	".claude",
	".codex",
	".rescue",
	".agents",
	".gstack",
	".superpowers",
	".guardrails",
	".playwright-cli",
	".playwright-mcp",
	".vscode",
	"venv",
	".venv",
	"coverage",
	"__pycache__",
	".tox",
	".pytest_cache",
	"*.dSYM",
	// Vendored upstream source conventions — universally too large to scan
	"vendor", // Go modules, PHP Composer, Ruby Bundler
	"third_party", // Chromium/Google convention (llama.cpp, sherpa-onnx, gRPC, TF)
	"third-party",
	"vendors",
];

export interface GitignorePattern {
	pattern: string;
	negated: boolean;
	directoryOnly: boolean;
	rooted: boolean;
	hasSlash: boolean;
}

export interface ProjectIgnoreMatcher {
	rootDir: string;
	patterns: GitignorePattern[];
	isIgnored(filePath: string, isDirectory?: boolean): boolean;
}

function resolveGitIgnoreRoot(startDir: string): string {
	const fallback = path.resolve(startDir);
	let current = fallback;
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return fallback;
		current = parent;
	}
}

function collapseSlashes(value: string): string {
	let out = "";
	let previousWasSlash = false;
	for (const ch of value) {
		if (ch === "/") {
			if (!previousWasSlash) out += ch;
			previousWasSlash = true;
			continue;
		}
		out += ch === "\\" ? "/" : ch;
		previousWasSlash = false;
	}
	return out;
}

function stripLeadingDotSlash(value: string): string {
	return value.startsWith("./") ? value.slice(2) : value;
}

function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end -= 1;
	return value.slice(0, end);
}

function stripLeadingSlashes(value: string): string {
	let start = 0;
	while (start < value.length && value[start] === "/") start += 1;
	return value.slice(start);
}

function normalizeIgnorePath(value: string): string {
	return collapseSlashes(stripLeadingDotSlash(value));
}

function stripTrailingSpaces(value: string): string {
	// Good-enough gitignore whitespace handling: unescaped trailing spaces are ignored.
	let end = value.length;
	while (end > 0 && value[end - 1] === " " && value[end - 2] !== "\\") end -= 1;
	return value.slice(0, end).replace(/\\ /g, " ");
}

function parseGitignoreContent(content: string): GitignorePattern[] {
	const patterns: GitignorePattern[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		let line = stripTrailingSpaces(rawLine.trimStart());
		if (!line || line.startsWith("#")) continue;
		let negated = false;
		if (line.startsWith("!")) {
			negated = true;
			line = line.slice(1);
		}
		line = normalizeIgnorePath(line);
		if (!line) continue;

		const directoryOnly = line.endsWith("/");
		if (directoryOnly) line = stripTrailingSlashes(line);
		const rooted = line.startsWith("/");
		if (rooted) line = stripLeadingSlashes(line);
		if (!line) continue;

		patterns.push({
			pattern: line,
			negated,
			directoryOnly,
			rooted,
			hasSlash: line.includes("/"),
		});
	}
	return patterns;
}

function expandGitignorePattern(pattern: GitignorePattern): string[] {
	const body = pattern.pattern;
	if (pattern.directoryOnly) {
		if (pattern.rooted || pattern.hasSlash) return [body, `${body}/**`];
		return [body, `${body}/**`, `**/${body}`, `**/${body}/**`];
	}
	if (pattern.rooted || pattern.hasSlash) return [body];
	return [body, `**/${body}`];
}

function matchesGitignorePattern(
	pattern: GitignorePattern,
	relativePath: string,
	isDirectory: boolean,
): boolean {
	const candidate = stripLeadingSlashes(normalizeIgnorePath(relativePath));
	if (!candidate) return false;
	const candidates = isDirectory ? [candidate, `${candidate}/`] : [candidate];
	const options = { dot: true, nocase: process.platform === "win32" };
	return expandGitignorePattern(pattern).some((expanded) => {
		if (isDirectory && expanded.endsWith("/**")) {
			const prefix = expanded.slice(0, -3);
			if (candidate === prefix || candidate.startsWith(`${prefix}/`))
				return true;
		}
		return candidates.some((value) => minimatch(value, expanded, options));
	});
}

export function readGitignorePatterns(rootDir: string): GitignorePattern[] {
	const gitignorePath = path.join(rootDir, ".gitignore");
	try {
		return parseGitignoreContent(fs.readFileSync(gitignorePath, "utf-8"));
	} catch {
		return [];
	}
}

function ancestorDirsBetween(rootDir: string, targetDir: string): string[] {
	const relative = path.relative(rootDir, targetDir);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return [];
	const dirs = [rootDir];
	if (!relative) return dirs;
	let current = rootDir;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		dirs.push(current);
	}
	return dirs;
}

function buildProjectIgnoreMatcher(
	resolvedRoot: string,
	patterns: GitignorePattern[],
): ProjectIgnoreMatcher {
	const nestedCache = new Map<
		string,
		{ gitignoreMtimeMs: number; patterns: GitignorePattern[] }
	>();
	const patternsForDir = (dir: string): GitignorePattern[] => {
		if (dir === resolvedRoot) return patterns;
		const gitignoreMtime = gitignoreMtimeMs(dir);
		const cached = nestedCache.get(dir);
		if (cached?.gitignoreMtimeMs === gitignoreMtime) return cached.patterns;
		const nextPatterns = readGitignorePatterns(dir);
		nestedCache.set(dir, {
			gitignoreMtimeMs: gitignoreMtime,
			patterns: nextPatterns,
		});
		return nextPatterns;
	};

	// Per-matcher path → boolean memo. The matcher itself is cached by
	// `getProjectIgnoreMatcher` keyed on `.gitignore` mtime, so this Map's
	// lifetime is bounded to a single set of ignore rules — when any
	// `.gitignore` changes, the matcher is rebuilt and the memo is dropped
	// with it. Without this memo, every background scan (comment scan, knip,
	// jscpd, call-graph, source-filter, pipeline) recomputes O(ancestorDirs ×
	// patterns) per file, multiplying into 2-3s of pure CPU on a 2k-file
	// project. With it, the second visitor of the same path is O(1).
	const isIgnoredMemo = new Map<string, boolean>();

	return {
		rootDir: resolvedRoot,
		patterns,
		isIgnored(filePath: string, isDirectory = false): boolean {
			const resolved = path.resolve(filePath);
			// Two namespaces (D: for directory queries, F: for file queries)
			// because gitignore semantics differ for trailing-slash patterns.
			const memoKey = (isDirectory ? "D:" : "F:") + resolved;
			const cached = isIgnoredMemo.get(memoKey);
			if (cached !== undefined) return cached;
			const rootRelative = path.relative(resolvedRoot, resolved);
			if (
				!rootRelative ||
				rootRelative.startsWith("..") ||
				path.isAbsolute(rootRelative)
			) {
				isIgnoredMemo.set(memoKey, false);
				return false;
			}

			let ignored = false;
			const patternDirs = ancestorDirsBetween(
				resolvedRoot,
				path.dirname(resolved),
			);
			for (const dir of patternDirs) {
				const dirPatterns = patternsForDir(dir);
				if (dirPatterns.length === 0) continue;
				const relative = path.relative(dir, resolved);
				const normalized = normalizeIgnorePath(relative);
				for (const pattern of dirPatterns) {
					if (!matchesGitignorePattern(pattern, normalized, isDirectory))
						continue;
					ignored = !pattern.negated;
				}
			}
			isIgnoredMemo.set(memoKey, ignored);
			return ignored;
		},
	};
}

export function createProjectIgnoreMatcher(
	rootDir: string,
	extraPatterns: string[] = [],
	globalPatterns: string[] = [],
): ProjectIgnoreMatcher {
	const resolvedRoot = resolveGitIgnoreRoot(rootDir);
	// Precedence is gitignore order: LATER patterns override earlier ones. So
	// global (lowest) → project .gitignore → project .pi-lens.json (highest),
	// which lets a project `!negation` re-include a globally-ignored path (#252).
	const patterns = [
		...parseGitignoreContent(globalPatterns.join("\n")),
		...readGitignorePatterns(resolvedRoot),
		...parseGitignoreContent(extraPatterns.join("\n")),
	];
	return buildProjectIgnoreMatcher(resolvedRoot, patterns);
}

const projectIgnoreMatcherCache = new Map<
	string,
	{
		gitignoreMtimeMs: number;
		lensConfigPath: string | undefined;
		lensConfigMtimeMs: number;
		globalConfigMtimeMs: number;
		matcher: ProjectIgnoreMatcher;
	}
>();

/**
 * mtime of the global `~/.pi-lens/config.json` (or the PI_LENS_CONFIG_PATH
 * override). Part of the ignore-matcher cache key so editing global ignore
 * patterns takes effect without a restart (#252). -1 when absent.
 */
function globalConfigMtimeMs(): number {
	try {
		return fs.statSync(getPiLensGlobalConfigPath()).mtimeMs;
	} catch {
		return -1;
	}
}

function gitignoreMtimeMs(rootDir: string): number {
	try {
		return fs.statSync(path.join(rootDir, ".gitignore")).mtimeMs;
	} catch {
		return -1;
	}
}

/**
 * The project config file found by the same upward walk as the loader. Cache
 * invalidation must track the actual file found, not only a file directly under
 * the git root: nested worktrees/submodules can legitimately inherit a
 * `.pi-lens.json` from a parent directory.
 */
function lensConfigInfo(rootDir: string): {
	info: ReturnType<typeof findPiLensProjectConfig>;
	path: string | undefined;
	mtimeMs: number;
} {
	const info = findPiLensProjectConfig(rootDir);
	return info
		? { info, path: info.path, mtimeMs: info.mtimeMs }
		: { info, path: undefined, mtimeMs: -1 };
}

export function getProjectIgnoreMatcher(rootDir: string): ProjectIgnoreMatcher {
	const resolvedRoot = resolveGitIgnoreRoot(rootDir);
	const gitignoreMtime = gitignoreMtimeMs(resolvedRoot);
	const lensConfig = lensConfigInfo(resolvedRoot);
	const globalMtime = globalConfigMtimeMs();
	const cached = projectIgnoreMatcherCache.get(resolvedRoot);
	if (
		cached?.gitignoreMtimeMs === gitignoreMtime &&
		cached?.lensConfigPath === lensConfig.path &&
		cached?.lensConfigMtimeMs === lensConfig.mtimeMs &&
		cached?.globalConfigMtimeMs === globalMtime
	) {
		return cached.matcher;
	}

	// Load both configs fresh on cache miss. On a cache HIT (the common case)
	// none of this runs — the only per-call cost is the mtime stats above. The
	// project loader is itself mtime-cached; the global loader re-parses, but
	// only here on miss (when some tracked mtime changed).
	const projectConfig = loadPiLensProjectConfig(resolvedRoot, lensConfig.info);
	const matcher = createProjectIgnoreMatcher(
		resolvedRoot,
		projectConfig.ignore,
		getGlobalIgnorePatterns(),
	);
	projectIgnoreMatcherCache.set(resolvedRoot, {
		gitignoreMtimeMs: gitignoreMtime,
		lensConfigPath: lensConfig.path,
		lensConfigMtimeMs: lensConfig.mtimeMs,
		globalConfigMtimeMs: globalMtime,
		matcher,
	});
	return matcher;
}

export function isPathIgnoredByProject(
	filePath: string,
	rootDir: string,
	isDirectory = false,
): boolean {
	return getProjectIgnoreMatcher(rootDir).isIgnored(filePath, isDirectory);
}

export function getProjectIgnoreGlobs(rootDir: string): string[] {
	return readGitignorePatterns(rootDir)
		.filter((pattern) => !pattern.negated)
		.flatMap((pattern) => expandGitignorePattern(pattern));
}

/**
 * Read simple directory-name entries from a root .gitignore.
 *
 * Prefer createProjectIgnoreMatcher() for path-aware gitignore matching. This
 * helper is kept for callers/tests that only need simple directory names.
 */
export function readGitignoreDirs(rootDir: string): string[] {
	return readGitignorePatterns(rootDir)
		.filter(
			(entry) =>
				!entry.negated &&
				!entry.pattern.includes("*") &&
				!entry.pattern.includes("?") &&
				!entry.pattern.includes("[") &&
				!entry.pattern.includes("/"),
		)
		.map((entry) => entry.pattern);
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Match directory name against exclusion patterns.
 * Supports exact names and lightweight glob patterns (for example `*.dSYM`).
 */
export function isExcludedDirName(
	dirName: string,
	extraPatterns: string[] = [],
): boolean {
	const candidate = dirName.trim();
	if (!candidate) return false;

	const patterns = [...EXCLUDED_DIRS, ...extraPatterns]
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	const candidateLower = candidate.toLowerCase();

	for (const pattern of patterns) {
		const patLower = pattern.toLowerCase();
		if (!patLower.includes("*") && !patLower.includes("?")) {
			if (candidateLower === patLower) return true;
			continue;
		}
		if (globToRegExp(pattern).test(candidate)) return true;
	}

	return false;
}

/**
 * Convert excluded directory names into glob patterns used by scanners.
 */
export function getExcludedDirGlobs(): string[] {
	return EXCLUDED_DIRS.map((dir) => `**/${dir}/**`);
}

/**
 * Shared Knip ignore patterns derived from central exclusions.
 */
export function getKnipIgnorePatterns(): string[] {
	return [
		...getExcludedDirGlobs(),
		"**/*.test.ts",
		"**/*.test.tsx",
		"**/*.test.js",
		"**/*.test.jsx",
		"**/*.spec.ts",
		"**/*.spec.tsx",
		"**/*.spec.js",
		"**/*.spec.jsx",
		"**/*.poc.test.ts",
		"**/*.poc.test.tsx",
		"**/__tests__/**",
		"**/tests/**",
	];
}

/**
 * Spawn a command and detect whether it modified a file on disk.
 * Returns 1 if the file content changed after the command ran, 0 otherwise.
 * Useful for auto-fix tools (ESLint, Stylelint, RuboCop, etc.).
 */
export async function detectFileChangedAfterCommand(
	filePath: string,
	command: string,
	args: string[],
	cwd: string,
	ignoreStatuses: number[] = [],
): Promise<number> {
	let before = "";
	try {
		before = fs.readFileSync(filePath, "utf-8");
	} catch {
		return 0;
	}

	const result = await safeSpawnAsync(command, args, {
		timeout: 30000,
		cwd,
	});
	if (result.error) return 0;
	if (result.status !== 0 && !ignoreStatuses.includes(result.status ?? -1)) {
		return 0;
	}

	try {
		const after = fs.readFileSync(filePath, "utf-8");
		return before !== after ? 1 : 0;
	} catch {
		return 0;
	}
}

/**
 * Check if file path is a test/fixture/mock file.
 * Used by secrets scanner, rate command, and dispatch runners
 * to skip these files (false positives on fake credentials, etc).
 */
export function isTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return (
		normalized.includes(".test.") ||
		normalized.includes(".spec.") ||
		normalized.includes("/test/") ||
		normalized.includes("/tests/") ||
		normalized.includes("__tests__/") ||
		normalized.includes("test-utils") ||
		normalized.startsWith("test-") ||
		normalized.includes(".fixture.") ||
		normalized.includes(".mock.")
	);
}
