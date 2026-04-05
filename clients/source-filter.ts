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
 * Files without higher-precedence siblings are always kept (hand-written JS, Python,
 * Go, Rust, etc.).
 */

import * as fs from "node:fs";
import * as path from "node:path";

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
export function findSourceSibling(filePath: string): string | null {
	const ext = path.extname(filePath).toLowerCase();
	const dir = getDir(filePath);
	const base = getBasename(filePath);

	// Find which precedence group this extension belongs to
	for (const [sourceExt, shadowedExts] of Object.entries(SOURCE_PRECEDENCE)) {
		if (shadowedExts.includes(ext)) {
			// This file could be shadowed by a source file with sourceExt
			const siblingPath = path.join(dir, base + sourceExt);
			if (fs.existsSync(siblingPath)) {
				return siblingPath;
			}
		}
	}

	return null;
}

/**
 * Check if a file is a build artifact (has a source sibling).
 */
export function isBuildArtifact(filePath: string): boolean {
	return findSourceSibling(filePath) !== null;
}

/**
 * Filter a list of files, removing build artifacts that have source siblings.
 * Returns de-duplicated list keeping only highest-precedence sources.
 */
export function filterSourceFiles(filePaths: string[]): string[] {
	// Track which files we're keeping and why we're skipping others
	const keep: string[] = [];
	const skipReasons = new Map<string, string>(); // skipped file -> kept source

	for (const filePath of filePaths) {
		const sourceSibling = findSourceSibling(filePath);
		if (sourceSibling) {
			// This is a build artifact, skip it
			skipReasons.set(filePath, sourceSibling);
		} else {
			// No higher-precedence source, keep it
			keep.push(filePath);
		}
	}

	return keep;
}

/**
 * Recursively collect all source files in a directory, excluding build artifacts.
 *
 * @param dir - Directory to scan
 * @param options - Optional configuration
 * @returns Array of absolute file paths that are source files (not build artifacts)
 */
export function collectSourceFiles(
	dir: string,
	options?: {
		/** Additional directory names to exclude (merged with defaults) */
		excludeDirs?: string[];
		/** File extensions to consider (defaults to ALL_SCANNABLE_EXTENSIONS) */
		extensions?: string[];
		/** Whether to follow symlinks (default: false) */
		followSymlinks?: boolean;
	},
): string[] {
	const excludeDirs = new Set([
		"node_modules",
		".git",
		"dist",
		"build",
		".next",
		"coverage",
		"__pycache__",
		".cache",
		"target", // Rust
		"out",
		"*.dSYM", // macOS debug symbols
		...(options?.excludeDirs || []),
	]);

	const extensions = new Set(options?.extensions || ALL_SCANNABLE_EXTENSIONS);

	const files: string[] = [];

	function scan(currentDir: string) {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return; // Permission denied or directory doesn't exist
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				if (excludeDirs.has(entry.name)) continue;
				if (!options?.followSymlinks && entry.isSymbolicLink()) continue;
				scan(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (!extensions.has(ext)) continue;

				// Skip if this is a build artifact
				if (isBuildArtifact(fullPath)) continue;

				files.push(fullPath);
			}
		}
	}

	scan(path.resolve(dir));
	return files;
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
