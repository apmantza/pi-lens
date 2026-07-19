/**
 * Shared file path utilities for pi-lens
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { minimatch } from "./deps/minimatch.js";
import { collectTrackedFiles, getTrackedFilesSnapshot } from "./git-tracked-ignore.js";
import {
	getGlobalIgnorePatterns,
	getPiLensGlobalConfigPath,
} from "./lens-config.js";
import { normalizeEphemeralMapKey, normalizeFilePath } from "./path-utils.js";
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
	const base = configuredBase || path.join(getGlobalPiLensDir(), "projects");
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
 * Machine-global pi-lens directory: `~/.pi-lens/` by default.
 *
 * Used for logs (latency, cascade, read-guard, tree-sitter, actionable-warnings,
 * sessionstart), tool binaries (`~/.pi-lens/tools/`, `~/.pi-lens/bin/`), the
 * cross-process instance registry (`instances.json`, #449/#525), the
 * auto-install probe cache, and other state that is intentionally NOT
 * project-scoped — it spans every project pi-lens has touched.
 *
 * Override: set `PI_LENS_HOME=/some/path` to relocate this ENTIRE root (every
 * caller below routes through this one function, so one env var covers all of
 * them — see #525). Tests MUST set this to a per-worker temp dir in
 * `tests/support/vitest-setup.ts` rather than mocking each caller separately;
 * otherwise a test that exercises `registerInstance`/`sweepOrphans` or any
 * logger writes into the developer's REAL `~/.pi-lens` (dogfooded live: a
 * test-fixture instance survived in the real `instances.json` for 17h).
 *
 * Distinct from `getProjectDataDir(cwd)`, which respects `PILENS_DATA_DIR`
 * (project-scoped) and produces per-project subdirectories. Callers writing
 * project caches, snapshots, or worklogs should use `getProjectDataDir(cwd)`
 * instead — `PI_LENS_HOME` is the MACHINE-scoped sibling of that override.
 */
export function getGlobalPiLensDir(): string {
	const override = process.env.PI_LENS_HOME?.trim();
	if (override) return path.resolve(override);
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

/**
 * Which layer produced a pattern, per #703's layer-semantics fix. Precedence
 * (lowest → highest) is `global` → `gitignore` → `pilens` — see
 * `createProjectIgnoreMatcher`'s ordering comment. The layer determines
 * whether a winning positive match is subject to git's "a tracked file is
 * never ignored" rule:
 *   - `global` / `gitignore` emulate git itself, so they inherit that rule —
 *     a winning match from either NEVER excludes a file git tracks.
 *   - `pilens` (`.pi-lens.json`'s `ignore` field) is pi-lens-native user
 *     intent ("don't analyze this"), not a git emulation, so it excludes
 *     regardless of tracked status.
 */
export type GitignorePatternLayer = "global" | "gitignore" | "pilens";

export interface GitignorePattern {
	pattern: string;
	negated: boolean;
	directoryOnly: boolean;
	rooted: boolean;
	hasSlash: boolean;
	layer: GitignorePatternLayer;
}

export interface ProjectIgnoreMatcher {
	rootDir: string;
	patterns: GitignorePattern[];
	isIgnored(filePath: string, isDirectory?: boolean): boolean;
	/**
	 * Primes the tracked-files set for `rootDir` (async `git ls-files`,
	 * memoized — see `git-tracked-ignore.ts`) so subsequent synchronous
	 * `isIgnored` calls in the SAME walk can honor #703's tracked-aware
	 * layer semantics. Callers with an async walk loop should await this
	 * ONCE before the loop starts, not per file. Fail-open: resolves even
	 * when git is absent/fails/times out (tracked-check then silently stays
	 * unavailable and `isIgnored` degrades to today's pattern-only
	 * behavior). Sync callers that never call this simply never prime — that
	 * degrade-to-pattern-only is intended, not a bug.
	 */
	ensureTrackedIndex(): Promise<void>;
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

function parseGitignoreContent(
	content: string,
	layer: GitignorePatternLayer,
): GitignorePattern[] {
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
			layer,
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

export function readGitignorePatterns(
	rootDir: string,
	layer: GitignorePatternLayer = "gitignore",
): GitignorePattern[] {
	const gitignorePath = path.join(rootDir, ".gitignore");
	try {
		return parseGitignoreContent(fs.readFileSync(gitignorePath, "utf-8"), layer);
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

	// Per-matcher path → pattern-verdict memo. The matcher itself is cached by
	// `getProjectIgnoreMatcher` keyed on `.gitignore` mtime, so this Map's
	// lifetime is bounded to a single set of ignore rules — when any
	// `.gitignore` changes, the matcher is rebuilt and the memo is dropped
	// with it. Without this memo, every background scan (comment scan, knip,
	// jscpd, call-graph, source-filter, pipeline) recomputes O(ancestorDirs ×
	// patterns) per file, multiplying into 2-3s of pure CPU on a 2k-file
	// project. With it, the second visitor of the same path is O(1).
	//
	// #703: this memoizes only the PATTERN verdict (which is deterministic —
	// it never changes for a given matcher instance), NOT the tracked-aware
	// final verdict. The tracked-files set can transition from "not yet
	// primed" to "primed" mid-process (a walker calls `ensureTrackedIndex()`
	// partway through the matcher's lifetime), so baking the tracked check
	// into this memo would let an early, pre-priming call poison every later
	// lookup of the same path for this matcher's entire cache lifetime. The
	// tracked-set lookup itself is a cheap Set#has over syntactically-folded
	// keys (see `isTrackedAndRescued` — no `realpathSync` anywhere in this
	// function), and — critically — it's only ever paid for paths a pattern
	// already flagged as ignored, so it doesn't reintroduce the per-file cost
	// this memo exists to avoid for the common (not-ignored) case.
	const patternMemo = new Map<
		string,
		{ ignored: boolean; layer: GitignorePatternLayer | undefined }
	>();

	// #703 perf follow-up: `normalizeEphemeralMapKey` (cheap slash-fold +
	// Windows-lowercase, zero fs I/O), NOT `normalizeMapKey` (realpath-backed).
	// This runs on every `isIgnored` call that reaches this branch — walks
	// over this repo alone visit thousands of pattern-ignored compiled
	// `*.js`/`*.d.ts` files, and `dispatch/integration.ts`'s per-edit cascade
	// check hits it too — so a `realpathSync` here would violate the
	// event-loop/slow-FS discipline `isIgnored` is required to keep (#462: 75x
	// slower on 9p/drvfs). Both `resolved` (this matcher's own `path.resolve`,
	// never realpath'd) and the tracked-set's keys (`git-tracked-ignore.ts`,
	// realpath'd ONCE per fetch on the shared root, not per file) are
	// self-consistent within one process/session, which is exactly
	// `normalizeEphemeralMapKey`'s contract — see that function's doc and
	// `git-tracked-ignore.ts`'s module doc for the full reasoning. Accepted
	// edge case: a symlinked or 8.3-short-name project root can make the cheap
	// fold miss even after the fetch side's one realpath — the file then stays
	// pattern-ignored, i.e. degrades to today's (pre-#703) behavior, which is
	// consistent with this whole feature's fail-open contract.
	function isTrackedAndRescued(resolved: string): boolean {
		const snapshot = getTrackedFilesSnapshot(resolvedRoot);
		if (!snapshot) return false; // never primed / git unavailable: fail-open to pattern-only
		return snapshot.has(normalizeEphemeralMapKey(resolved));
	}

	return {
		rootDir: resolvedRoot,
		patterns,
		ensureTrackedIndex(): Promise<void> {
			return collectTrackedFiles(resolvedRoot).then(() => undefined);
		},
		isIgnored(filePath: string, isDirectory = false): boolean {
			const resolved = path.resolve(filePath);
			// Two namespaces (D: for directory queries, F: for file queries)
			// because gitignore semantics differ for trailing-slash patterns.
			const memoKey = (isDirectory ? "D:" : "F:") + resolved;
			let verdict = patternMemo.get(memoKey);
			if (verdict === undefined) {
				const rootRelative = path.relative(resolvedRoot, resolved);
				if (
					!rootRelative ||
					rootRelative.startsWith("..") ||
					path.isAbsolute(rootRelative)
				) {
					verdict = { ignored: false, layer: undefined };
				} else {
					let ignored = false;
					let layer: GitignorePatternLayer | undefined;
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
							layer = pattern.layer;
						}
					}
					verdict = { ignored, layer };
				}
				patternMemo.set(memoKey, verdict);
			}

			if (!verdict.ignored) return false;
			// #703 layer semantics: a winning positive match from `global` or
			// `gitignore` emulates git, so it inherits git's "a tracked file is
			// never ignored" rule. A winning match from `pilens` is pi-lens-native
			// intent and stays excluded regardless of tracked status. Directory
			// queries are never tracked-rescued — the tracked set is a file-id
			// set, not a directory set.
			if (
				!isDirectory &&
				verdict.layer !== "pilens" &&
				isTrackedAndRescued(resolved)
			) {
				return false;
			}
			return true;
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
	// Each layer is tagged (#703) so `isIgnored` can tell a git-emulating match
	// (`global`/`gitignore` — subject to "a tracked file is never ignored")
	// apart from pi-lens-native intent (`pilens` — excludes regardless).
	const patterns = [
		...parseGitignoreContent(globalPatterns.join("\n"), "global"),
		...readGitignorePatterns(resolvedRoot, "gitignore"),
		...parseGitignoreContent(extraPatterns.join("\n"), "pilens"),
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
