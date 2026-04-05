import * as fs from "node:fs";
import * as path from "node:path";
import { EXCLUDED_DIRS, isTestFile } from "./file-utils.js";
import { collectSourceFiles, isBuildArtifact } from "./source-filter.js";

/**
 * Common parsing logic for ast-grep JSON output (handles both array and NDJSON).
 */
// biome-ignore lint/suspicious/noExplicitAny: ast-grep JSON output is untyped
export function parseAstGrepJson(raw: string): any[] {
	if (!raw) return [];
	const trimmed = raw.trim();
	if (trimmed.startsWith("[")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return [];
		}
	}
	return trimmed.split("\n").flatMap((l) => {
		try {
			return [JSON.parse(l)];
		} catch {
			return [];
		}
	});
}

/**
 * Check if a file should be ignored based on project type and common patterns.
 *
 * @deprecated Use `isBuildArtifact()` from `source-filter.js` instead for artifact
 * detection, or compose your own filter using `collectSourceFiles()`. This function
 * is kept for backward compatibility.
 */
export function shouldIgnoreFile(
	filePath: string,
	isTsProject: boolean,
): boolean {
	const relPath = filePath.replace(/\\/g, "/");
	const _basename = path.basename(relPath);

	// Use new source-filter module for artifact detection
	if (isTsProject && isBuildArtifact(filePath)) return true;

	// Legacy: simple JS check for non-TS projects (hand-written JS)
	const isJs =
		relPath.endsWith(".js") ||
		relPath.endsWith(".mjs") ||
		relPath.endsWith(".cjs");
	if (isTsProject && isJs) return true;

	// Ignore test scripts and common test patterns
	if (isTestFile(filePath)) return true;

	// Ignore hidden directories and common build outputs
	if (EXCLUDED_DIRS.some((d) => relPath.includes(`/${d}/`))) return true;

	return false;
}

/**
 * Recursively find source files in a directory, respecting common excludes.
 *
 * This function now delegates to `collectSourceFiles()` from the `source-filter`
 * module for unified artifact detection across all scanners.
 *
 * @param dir - Directory to scan
 * @param isTsProject - Deprecated parameter (kept for backward compatibility, not used)
 * @returns Array of absolute file paths that are source files (not build artifacts)
 */
export function getSourceFiles(dir: string, _isTsProject?: boolean): string[] {
	// Delegate to the unified source-filter module
	// isTsProject parameter is no longer needed — artifact detection is automatic
	return collectSourceFiles(dir);
}
