import {
	collectSourceFiles,
	collectSourceFilesAsync,
} from "./source-filter.js";

/**
 * Common parsing logic for ast-grep JSON output (handles both array and NDJSON).
 */

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

/**
 * Async, event-loop-friendly twin of {@link getSourceFiles}. Returns the same
 * file list but yields to the loop while walking, so a large tree never holds
 * the loop in one synchronous burst. Background / deferred scanners (todo,
 * project-diagnostics, etc.) should prefer this over the sync version.
 */
export function getSourceFilesAsync(
	dir: string,
	_isTsProject?: boolean,
): Promise<string[]> {
	return collectSourceFilesAsync(dir);
}
