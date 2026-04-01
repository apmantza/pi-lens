/**
 * Path utilities for pi-lens
 *
 * Handles cross-platform path normalization, particularly
 * Windows case-insensitivity issues when using paths as Map keys.
 *
 * Inspired by OpenCode's separator-agnostic path handling:
 * - Convert backslashes to forward slashes for comparison
 * - Case-insensitive only on Windows (drive letter or UNC paths)
 * - Preserve original casing for URIs
 */

import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Detect if a path is a Windows path (has drive letter or UNC prefix).
 */
function isWindowsPath(filePath: string): boolean {
	return /^[A-Za-z]:/.test(filePath) || filePath.startsWith("\\\\");
}

/**
 * Normalize a file path for consistent Map key usage.
 *
 * - Converts backslashes to forward slashes (separator-agnostic)
 * - On Windows: lowercases (case-insensitive filesystem)
 * - On other platforms: returns as-is (case-sensitive filesystem)
 *
 * This ensures that "C:\Foo\bar.ts" and "c:/foo/bar.ts" resolve to the same key.
 */
export function normalizeFilePath(filePath: string): string {
	// Convert backslashes to forward slashes first
	const normalized = filePath.replace(/\\/g, "/");
	if (process.platform === "win32" || isWindowsPath(normalized)) {
		return normalized.toLowerCase();
	}
	return normalized;
}

/**
 * Convert a file:// URI to a normalized path.
 * Handles URL decoding and Windows drive letter normalization.
 */
export function uriToPath(uri: string): string {
	try {
		const filePath = fileURLToPath(uri);
		return normalizeFilePath(filePath);
	} catch {
		// Not a valid file:// URI, treat as plain path
		return normalizeFilePath(uri);
	}
}

/**
 * Convert a path to a file:// URI.
 * Does NOT normalize the path - URIs preserve original casing.
 */
export function pathToUri(filePath: string): string {
	return pathToFileURL(filePath).href;
}

/**
 * Normalize a Map key lookup for file paths.
 * Use this when getting/setting values in Maps that use file paths as keys.
 */
export function normalizeMapKey(filePath: string): string {
	return normalizeFilePath(filePath);
}

/**
 * Compare two file paths for equality, handling Windows case-insensitivity
 * and mixed separators (backslash vs forward slash).
 *
 * Like OpenCode's approach: normalize both for comparison, but don't
 * assume the platform — detect Windows paths by content.
 */
export function pathsEqual(a: string, b: string): boolean {
	return normalizeFilePath(a) === normalizeFilePath(b);
}

/**
 * Check if `child` is under `parent` directory.
 * Separator-agnostic and case-insensitive on Windows.
 */
export function isUnderDir(child: string, parent: string): boolean {
	const normChild = normalizeFilePath(child);
	const normParent = normalizeFilePath(parent);
	// Ensure parent ends with / for prefix matching
	const parentPrefix = normParent.endsWith("/") ? normParent : `${normParent}/`;
	return normChild === normParent || normChild.startsWith(parentPrefix);
}
