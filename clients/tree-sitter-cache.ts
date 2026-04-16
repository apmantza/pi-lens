/**
 * Tree-sitter Tree Cache with Incremental Parsing Support
 *
 * Caches parsed ASTs and enables incremental updates for large files.
 * This provides 10-100× speedup on edits to large files (>1000 lines).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { normalizeFilePath } from "./path-utils.js";

export interface CachedTree {
	tree: any; // Tree-sitter Tree instance
	contentHash: string;
	languageId: string;
	fileSize: number;
	lineCount: number;
	lastModified: number;
}

export class TreeCache {
	private cache = new Map<string, CachedTree>();
	private maxSize: number;
	private debug: (msg: string) => void;

	constructor(maxSize = 50, debug = false) {
		this.maxSize = maxSize;
		this.debug = debug
			? (msg: string) => console.error(`[tree-cache] ${msg}`)
			: () => {};
	}

	/**
	 * Generate hash for file content
	 */
	private hashContent(content: string): string {
		return crypto
			.createHash("sha256")
			.update(content)
			.digest("hex")
			.slice(0, 16);
	}

	/**
	 * Get cache key for a file
	 */
	private getCacheKey(filePath: string, languageId: string): string {
		return `${languageId}:${normalizeFilePath(filePath)}`;
	}

	/**
	 * Check if tree is cached and valid
	 */
	get(filePath: string, content: string, languageId: string): any | null {
		const key = this.getCacheKey(filePath, languageId);
		const cached = this.cache.get(key);

		if (!cached) {
			this.debug(`Cache miss: ${filePath}`);
			return null;
		}

		// Verify language matches
		if (cached.languageId !== languageId) {
			this.debug(`Language mismatch for ${filePath}`);
			this.cache.delete(key);
			return null;
		}

		// Check content hash
		const contentHash = this.hashContent(content);
		if (cached.contentHash !== contentHash) {
			this.debug(
				`Content changed: ${filePath} (${cached.lineCount} → ${content.split("\n").length} lines)`,
			);
			// Keep old tree for potential incremental update, but mark as stale
			return null;
		}

		// Check if file was modified on disk (mtime changed)
		try {
			const stats = fs.statSync(filePath);
			if (stats.mtimeMs !== cached.lastModified) {
				this.debug(`File modified on disk: ${filePath}`);
				this.cache.delete(key);
				return null;
			}
		} catch {
			// File might be deleted, invalidate cache
			this.cache.delete(key);
			return null;
		}

		this.debug(`Cache hit: ${filePath} (${cached.lineCount} lines)`);
		return cached.tree;
	}

	/**
	 * Store parsed tree in cache
	 */
	set(filePath: string, content: string, languageId: string, tree: any): void {
		// Evict oldest entries if cache is full
		if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				this.cache.delete(firstKey);
				this.debug(`Evicted: ${firstKey}`);
			}
		}

		const key = this.getCacheKey(filePath, languageId);
		let mtime = 0;
		try {
			mtime = fs.statSync(filePath).mtimeMs;
		} catch {
			// File deleted between parse and cache — cache with mtime=0;
			// next get() will miss on mtime check and re-parse
		}

		this.cache.set(key, {
			tree,
			contentHash: this.hashContent(content),
			languageId,
			fileSize: content.length,
			lineCount: content.split("\n").length,
			lastModified: mtime,
		});

		this.debug(`Cached: ${filePath} (${content.split("\n").length} lines)`);
	}

	/**
	 * Calculate the diff between old and new content
	 * Returns edit information for incremental parsing
	 */
	calculateEdit(
		oldContent: string,
		newContent: string,
	): {
		startIndex: number;
		oldEndIndex: number;
		newEndIndex: number;
		startPosition: { row: number; column: number };
		oldEndPosition: { row: number; column: number };
		newEndPosition: { row: number; column: number };
	} | null {
		// Find the first difference
		let startIndex = 0;
		while (
			startIndex < oldContent.length &&
			startIndex < newContent.length &&
			oldContent[startIndex] === newContent[startIndex]
		) {
			startIndex++;
		}

		// Find the last difference (working backwards)
		let oldEndIndex = oldContent.length;
		let newEndIndex = newContent.length;
		while (
			oldEndIndex > startIndex &&
			newEndIndex > startIndex &&
			oldContent[oldEndIndex - 1] === newContent[newEndIndex - 1]
		) {
			oldEndIndex--;
			newEndIndex--;
		}

		// No change detected
		if (startIndex === oldContent.length && startIndex === newContent.length) {
			return null;
		}

		// Calculate positions
		const startPosition = this.indexToPosition(oldContent, startIndex);
		const oldEndPosition = this.indexToPosition(oldContent, oldEndIndex);
		const newEndPosition = this.indexToPosition(newContent, newEndIndex);

		return {
			startIndex,
			oldEndIndex,
			newEndIndex,
			startPosition,
			oldEndPosition,
			newEndPosition,
		};
	}

	/**
	 * Convert byte index to row/column position
	 */
	private indexToPosition(
		content: string,
		index: number,
	): { row: number; column: number } {
		const lines = content.slice(0, index).split("\n");
		return {
			row: lines.length - 1,
			column: lines[lines.length - 1].length,
		};
	}

	/**
	 * Attempt incremental update using tree.edit()
	 * Returns updated tree or null if incremental update failed
	 */
	async incrementalUpdate(
		filePath: string,
		oldContent: string,
		newContent: string,
		languageId: string,
		parser: any,
	): Promise<any | null> {
		const key = this.getCacheKey(filePath, languageId);
		const cached = this.cache.get(key);

		if (!cached) {
			this.debug(`No cached tree for incremental update: ${filePath}`);
			return null;
		}

		// Only use incremental for large files (>100 lines)
		const lineCount = oldContent.split("\n").length;
		if (lineCount < 100) {
			this.debug(
				`File too small for incremental: ${filePath} (${lineCount} lines)`,
			);
			return null;
		}

		// Calculate edit
		const edit = this.calculateEdit(oldContent, newContent);
		if (!edit) {
			this.debug(`No edit detected for: ${filePath}`);
			return null;
		}

		this.debug(
			`Incremental update: ${filePath} (lines ${edit.startPosition.row}-${edit.oldEndPosition.row})`,
		);

		try {
			// Apply edit to tree
			cached.tree.edit({
				startIndex: edit.startIndex,
				oldEndIndex: edit.oldEndIndex,
				newEndIndex: edit.newEndIndex,
				startPosition: edit.startPosition,
				oldEndPosition: edit.oldEndPosition,
				newEndPosition: edit.newEndPosition,
			});

			// Re-parse only changed region
			const newTree = parser.parse(newContent, cached.tree);

			// Update cache
			this.set(filePath, newContent, languageId, newTree);

			this.debug(`Incremental update successful: ${filePath}`);
			return newTree;
		} catch (err) {
			this.debug(`Incremental update failed: ${err}`);
			return null;
		}
	}

	/**
	 * Clear cache for a specific file
	 */
	invalidate(filePath: string, languageId?: string): void {
		if (languageId) {
			const key = this.getCacheKey(filePath, languageId);
			this.cache.delete(key);
			this.debug(`Invalidated: ${key}`);
		} else {
			// Invalidate all entries for this file
			for (const [key, value] of this.cache.entries()) {
				if (key.includes(filePath)) {
					this.cache.delete(key);
					this.debug(`Invalidated: ${key}`);
				}
			}
		}
	}

	/**
	 * Clear entire cache
	 */
	clear(): void {
		this.cache.clear();
		this.debug("Cache cleared");
	}

	/**
	 * Get cache statistics
	 */
	getStats(): {
		size: number;
		maxSize: number;
		totalLines: number;
		totalBytes: number;
	} {
		let totalLines = 0;
		let totalBytes = 0;
		for (const entry of this.cache.values()) {
			totalLines += entry.lineCount;
			totalBytes += entry.fileSize;
		}
		return {
			size: this.cache.size,
			maxSize: this.maxSize,
			totalLines,
			totalBytes,
		};
	}
}
