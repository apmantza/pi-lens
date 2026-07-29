/**
 * Tree-sitter Tree Cache
 *
 * Caches parsed ASTs so a file written once is parsed once and reused by every
 * subsystem that inspects it in the same process (#675).
 *
 * Freshness is hash-authoritative when the caller supplies content: identical
 * bytes parse to an identical tree, so a hash match is a hit even if the file's
 * mtime moved (an agent re-saving unchanged bytes must not force a reparse,
 * #890). Eviction is true LRU — hits re-insert their entry, so set() dropping
 * the Map's first key removes the least-recently-used file, not merely the
 * oldest insertion, and hot per-edit files survive scan traffic (#890).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { normalizeFilePath } from "./path-utils.js";

const TREE_RETIREMENT_GRACE_MICROTASKS = 4;

export interface CachedTree {
	tree: any; // Tree-sitter Tree instance
	contentHash: string;
	languageId: string;
	fileSize: number;
	lineCount: number;
	lastModified: number;
}

export interface TreeCacheCounters {
	lookups: number;
	hits: number;
	coldMisses: number;
	capacityMisses: number;
	contentChangedMisses: number;
	mtimeMisses: number;
	statFailedMisses: number;
	sets: number;
	replacements: number;
	evictions: number;
	clears: number;
	ghostHistoryDrops: number;
}

export const TREE_CACHE_COUNTER_KEYS = [
	"lookups",
	"hits",
	"coldMisses",
	"capacityMisses",
	"contentChangedMisses",
	"mtimeMisses",
	"statFailedMisses",
	"sets",
	"replacements",
	"evictions",
	"clears",
	"ghostHistoryDrops",
] as const satisfies readonly (keyof TreeCacheCounters)[];

export function createTreeCacheCounters(): TreeCacheCounters {
	return Object.fromEntries(
		TREE_CACHE_COUNTER_KEYS.map((key) => [key, 0]),
	) as unknown as TreeCacheCounters;
}

export interface TreeCacheStats extends TreeCacheCounters {
	size: number;
	maxSize: number;
	totalLines: number;
	totalBytes: number;
	misses: number;
}

export type TreeCacheCounterObserver = (
	key: keyof TreeCacheCounters,
	amount: number,
) => void;

export class TreeCache {
	private cache = new Map<string, CachedTree>();
	private recentlyEvicted = new Map<string, string>();
	private maxSize: number;
	private evictionHistoryMax: number;
	private debug: (msg: string) => void;
	private counters = createTreeCacheCounters();
	private counterObserver: TreeCacheCounterObserver | undefined;
	private treeErrorObserver: ((error: unknown) => void) | undefined;

	constructor(
		maxSize = 50,
		debug = false,
		evictionHistoryMax = 4096,
		counterObserver?: TreeCacheCounterObserver,
		treeErrorObserver?: (error: unknown) => void,
	) {
		this.maxSize = maxSize;
		this.evictionHistoryMax = Math.max(1, Math.floor(evictionHistoryMax));
		this.counterObserver = counterObserver;
		this.treeErrorObserver = treeErrorObserver;
		this.debug = debug
			? (msg: string) => console.error(`[tree-cache] ${msg}`)
			: () => {};
	}

	private recordCounter(key: keyof TreeCacheCounters, amount = 1): void {
		this.counters[key] += amount;
		this.counterObserver?.(key, amount);
	}

	/**
	 * Free a tree-sitter Tree's WASM-heap allocation.
	 *
	 * web-tree-sitter Trees live in the WASM heap; JS GC reclaims only the wrapper,
	 * so the underlying memory leaks unless `tree.delete()` is called explicitly
	 * (no FinalizationRegistry auto-free in 0.25). Guarded — a tree may already be
	 * deleted, or `delete()` may throw on a corrupt/aborted runtime. Retirement is
	 * deferred so direct parse callers resume before deletion; consumers still
	 * traverse without another await, or use the cache-safe callback API (#417).
	 * The eviction target is the least-recently-used entry (get() re-inserts
	 * hits), never the just-parsed tree still in a caller's hand.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter Tree
	private freeTree(tree: any): void {
		try {
			if (tree && typeof tree.delete === "function") tree.delete();
		} catch (error) {
			this.treeErrorObserver?.(error);
		}
	}

	private retireTree(tree: any): void {
		let remaining = TREE_RETIREMENT_GRACE_MICROTASKS;
		const retire = (): void => {
			if (remaining-- > 0) {
				queueMicrotask(retire);
				return;
			}
			this.freeTree(tree);
		};
		queueMicrotask(retire);
	}

	/** Remove a cache entry and retire its WASM tree after current consumers run. */
	private removeEntry(key: string): void {
		const cached = this.cache.get(key);
		if (cached) this.retireTree(cached.tree);
		this.cache.delete(key);
	}

	private rememberEviction(key: string, cached: CachedTree): void {
		this.recentlyEvicted.delete(key);
		if (this.recentlyEvicted.size >= this.evictionHistoryMax) {
			const oldestKey = this.recentlyEvicted.keys().next().value;
			if (oldestKey !== undefined) {
				this.recentlyEvicted.delete(oldestKey);
				this.recordCounter("ghostHistoryDrops");
			}
		}
		this.recentlyEvicted.set(key, cached.contentHash);
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
	 * Check if tree is cached and valid.
	 *
	 * When `content` is provided the content hash is AUTHORITATIVE: a hash match
	 * is a hit regardless of mtime, and the entry's stat metadata is refreshed
	 * so a save-without-change (same bytes, newer mtime) does not masquerade as
	 * a disk modification (#890). The mtime check remains the freshness signal
	 * only on the content-less path, where nothing else can prove the cached
	 * tree current (`mtimeMisses`). A stat failure invalidates on both paths —
	 * a deleted file's entry is dead weight and its WASM tree should be freed.
	 *
	 * Every hit re-inserts the entry (raw Map delete+set — NOT removeEntry,
	 * which would retire the live tree) so eviction is true LRU (#890).
	 */
	get(
		filePath: string,
		content: string | undefined,
		languageId: string,
	): any | null {
		this.recordCounter("lookups");
		const key = this.getCacheKey(filePath, languageId);
		const cached = this.cache.get(key);

		if (!cached) {
			const evictedHash = this.recentlyEvicted.get(key);
			if (
				evictedHash !== undefined &&
				content !== undefined &&
				evictedHash === this.hashContent(content)
			) {
				this.recordCounter("capacityMisses");
			} else {
				this.recordCounter("coldMisses");
			}
			this.debug(`Cache miss: ${filePath}`);
			return null;
		}

		// (No language-mismatch check needed: the cache key is prefixed with
		// languageId, so a key hit already implies the language matches.)

		if (content !== undefined) {
			// Check content hash — authoritative when content is provided.
			const contentHash = this.hashContent(content);
			if (cached.contentHash !== contentHash) {
				this.recordCounter("contentChangedMisses");
				this.debug(
					`Content changed: ${filePath} (${cached.lineCount} → ${content.split("\n").length} lines)`,
				);
				// Keep old tree for potential incremental update, but mark as stale
				return null;
			}
		}

		try {
			const stats = fs.statSync(filePath);
			if (content !== undefined) {
				// The hash already proved the tree current: an mtime delta is a
				// save-without-change (or touch/clock drift). Refresh metadata
				// instead of invalidating (#890). Caveat: this stamps the CURRENT
				// disk mtime onto an entry validated against caller-supplied
				// content — if that content lags a newer disk write, lastModified
				// no longer vouches for the disk bytes. So lastModified means
				// "mtime last observed on a hash-confirmed hit"; the content-less
				// path below may only treat it as freshness proof while all
				// callers pass content (today they all do — the undefined path is
				// exercised only by tests).
				if (stats.mtimeMs !== cached.lastModified) {
					cached.lastModified = stats.mtimeMs;
					this.debug(`Refreshed mtime on hash-matched entry: ${filePath}`);
				}
			} else if (stats.mtimeMs !== cached.lastModified) {
				// No content to hash — mtime is the only freshness proof.
				this.recordCounter("mtimeMisses");
				this.debug(`File modified on disk: ${filePath}`);
				this.removeEntry(key);
				return null;
			}
		} catch {
			// File might be deleted, invalidate cache
			this.recordCounter("statFailedMisses");
			this.removeEntry(key);
			return null;
		}

		// LRU touch: re-insert so this entry becomes the newest. The SAME entry
		// object is re-set — no tree replacement, so nothing is retired and a
		// retired tree can never be resurrected (#890).
		this.cache.delete(key);
		this.cache.set(key, cached);

		this.recordCounter("hits");
		this.debug(`Cache hit: ${filePath} (${cached.lineCount} lines)`);
		return cached.tree;
	}

	/**
	 * Store parsed tree in cache
	 */
	set(filePath: string, content: string, languageId: string, tree: any): void {
		this.recordCounter("sets");
		const key = this.getCacheKey(filePath, languageId);
		const contentHash = this.hashContent(content);
		this.recentlyEvicted.delete(key);

		// Free the tree we're about to replace at this key (re-parse of the same
		// file) so it doesn't leak its WASM heap.
		if (this.cache.has(key)) {
			this.recordCounter("replacements");
			this.removeEntry(key);
		} else if (this.cache.size >= this.maxSize) {
			// Evict + free the least-recently-used entry when the cache is full:
			// get() re-inserts hits, so Map insertion order IS recency order and
			// the first key is the LRU entry (#890).
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				const evicted = this.cache.get(firstKey);
				if (evicted) this.rememberEviction(firstKey, evicted);
				this.recordCounter("evictions");
				this.removeEntry(firstKey);
				this.debug(`Evicted: ${firstKey}`);
			}
		}

		let mtime = 0;
		try {
			mtime = fs.statSync(filePath).mtimeMs;
		} catch {
			// File deleted between parse and cache — cache with mtime=0;
			// next get() will miss on mtime check and re-parse
		}

		this.cache.set(key, {
			tree,
			contentHash,
			languageId,
			fileSize: Buffer.byteLength(content, "utf8"),
			lineCount: content.split("\n").length,
			lastModified: mtime,
		});

		this.debug(`Cached: ${filePath} (${content.split("\n").length} lines)`);
	}

	/**
	 * Clear entire cache
	 */
	clear(): void {
		this.recordCounter("clears");
		for (const entry of this.cache.values()) {
			this.retireTree(entry.tree);
		}
		this.cache.clear();
		this.recentlyEvicted.clear();
		this.debug("Cache cleared");
	}

	/**
	 * Get cache statistics
	 */
	getStats(): TreeCacheStats {
		let totalLines = 0;
		let totalBytes = 0;
		for (const entry of this.cache.values()) {
			totalLines += entry.lineCount;
			totalBytes += entry.fileSize;
		}
		return {
			...this.counters,
			size: this.cache.size,
			maxSize: this.maxSize,
			totalLines,
			totalBytes,
			misses: this.counters.lookups - this.counters.hits,
		};
	}
}
