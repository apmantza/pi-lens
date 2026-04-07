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
];

/**
 * Convert excluded directory names into glob patterns used by scanners.
 */
export function getExcludedDirGlobs(): string[] {
	return EXCLUDED_DIRS.map((dir) => `**/${dir}/**`);
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
