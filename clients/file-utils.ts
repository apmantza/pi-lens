/**
 * Shared file path utilities for pi-lens
 */

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
	".pi",              // pi agent directory
	".ruff_cache",      // Python linter cache
	"venv",
	".venv",
	"coverage",
	"__pycache__",
	".tox",
	".pytest_cache",
	"*.dSYM",
];

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
