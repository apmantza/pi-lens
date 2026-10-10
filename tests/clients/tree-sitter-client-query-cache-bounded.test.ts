/**
 * #2442 review F5/F7: `TreeSitterClient`'s `queryCache` / `queryBatchCache`
 * were the two LIVE `.entries().next().value` eviction sites the first draft
 * of the idiom sweep could not see (its regex matched only `.keys()`). They
 * are eviction-SIDE-EFFECT coupled — the dropped entry's compiled query owns a
 * native handle that must be `delete()`d — which is exactly why
 * `BoundedFifoMap.set()` returns `[key, value]` pairs rather than bare keys.
 *
 * `cacheQuery` / `cacheQueryBatch` are private, so this drives them through
 * the same `as unknown as` harness cast the rest of this repo's
 * TreeSitterClient internals tests use. The cached values are stand-ins for
 * compiled queries: the ONLY thing the production eviction path touches on
 * them is `value?.query?.delete?.()`, so a `{ query: { delete } }` double is
 * production-faithful on the axis under test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";

interface QueryDouble {
	query: { delete: () => void };
	users: number;
	retired: boolean;
	disposed: boolean;
}

interface Harness {
	cacheQuery(key: string, value: QueryDouble): void;
	cacheQueryBatch(key: string, value: QueryDouble | null): void;
	queryCache: {
		get(key: string): QueryDouble | undefined;
		has(key: string): boolean;
		readonly size: number;
	};
	queryBatchCache: { has(key: string): boolean; readonly size: number };
}

function harnessOf(client: TreeSitterClient): Harness {
	return client as unknown as Harness;
}

function queryDouble(): QueryDouble & { deleted: () => number } {
	const del = vi.fn();
	return {
		query: { delete: del },
		users: 0,
		retired: false,
		disposed: false,
		deleted: () => del.mock.calls.length,
	};
}

afterEach(() => {
	delete process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP;
	delete process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP;
});

describe("#2442 TreeSitterClient.queryCache (FIFO, frees the evicted query)", () => {
	it("evicts the oldest key and deletes its compiled query", () => {
		process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP = "2";
		const harness = harnessOf(new TreeSitterClient());
		const a = queryDouble();
		const b = queryDouble();

		harness.cacheQuery("a", a);
		harness.cacheQuery("b", b);
		expect(harness.queryCache.size).toBe(2);
		expect(a.deleted()).toBe(0);

		harness.cacheQuery("c", queryDouble());

		expect(harness.queryCache.size).toBe(2);
		expect(harness.queryCache.has("a")).toBe(false);
		// The eviction freed the native handle — the whole reason set() hands
		// back the VALUE and not just the key.
		expect(a.deleted()).toBe(1);
		expect(b.deleted()).toBe(0);
	});

	it("a get of the oldest key never reorders eviction order (red on an accidental LRU substitution)", () => {
		process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP = "2";
		const harness = harnessOf(new TreeSitterClient());
		harness.cacheQuery("a", queryDouble());
		harness.cacheQuery("b", queryDouble());

		for (let i = 0; i < 5; i++)
			expect(harness.queryCache.get("a")).toBeTruthy();

		harness.cacheQuery("c", queryDouble());

		// FIFO: the reads left order alone, so "a" is still oldest and goes.
		// Under an LRU substitution both assertions flip.
		expect(harness.queryCache.has("a")).toBe(false);
		expect(harness.queryCache.has("b")).toBe(true);
	});

	it("a re-cache of a resident key refreshes it (the site's own delete+set)", () => {
		process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP = "2";
		const harness = harnessOf(new TreeSitterClient());
		harness.cacheQuery("a", queryDouble());
		harness.cacheQuery("b", queryDouble());

		harness.cacheQuery("a", queryDouble()); // write-refresh: "a" is newest
		harness.cacheQuery("c", queryDouble());

		expect(harness.queryCache.has("a")).toBe(true);
		expect(harness.queryCache.has("b")).toBe(false);
	});

	it("a LOWERED env cap takes effect on the next write and frees what it drops", () => {
		// The cap is read per write, so the bounded map's ceiling is re-applied
		// on every cacheQuery — a lowered PI_LENS_TREE_SITTER_QUERY_CACHE_CAP
		// must shrink the live cache, not wait for a restart.
		process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP = "4";
		const harness = harnessOf(new TreeSitterClient());
		const a = queryDouble();
		const b = queryDouble();
		harness.cacheQuery("a", a);
		harness.cacheQuery("b", b);
		harness.cacheQuery("c", queryDouble());
		harness.cacheQuery("d", queryDouble());
		expect(harness.queryCache.size).toBe(4);

		process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP = "2";
		harness.cacheQuery("e", queryDouble());

		expect(harness.queryCache.size).toBe(2);
		expect(harness.queryCache.has("a")).toBe(false);
		expect(harness.queryCache.has("b")).toBe(false);
		// Both dropped entries were freed, including the ones the SHRINK took
		// rather than the ordinary overflow.
		expect(a.deleted()).toBe(1);
		expect(b.deleted()).toBe(1);
	});
});

describe("#2442 TreeSitterClient.queryBatchCache (FIFO, frees the evicted query)", () => {
	it("evicts the oldest key and deletes its compiled query", () => {
		process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP = "2";
		const harness = harnessOf(new TreeSitterClient());
		const a = queryDouble();

		harness.cacheQueryBatch("a", a);
		harness.cacheQueryBatch("b", queryDouble());
		harness.cacheQueryBatch("c", queryDouble());

		expect(harness.queryBatchCache.size).toBe(2);
		expect(harness.queryBatchCache.has("a")).toBe(false);
		expect(a.deleted()).toBe(1);
	});

	it("tolerates a null batch entry (the don't-retry marker) without throwing", () => {
		process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP = "1";
		const harness = harnessOf(new TreeSitterClient());
		harness.cacheQueryBatch("a", null);
		expect(() => harness.cacheQueryBatch("b", null)).not.toThrow();
		expect(harness.queryBatchCache.size).toBe(1);
	});
});
