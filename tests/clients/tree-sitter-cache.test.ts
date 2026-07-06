import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TreeCache } from "../../clients/tree-sitter-cache.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

// web-tree-sitter Trees hold WASM-heap memory that JS GC does NOT reclaim — the
// cache must call tree.delete() on every removal or it leaks (#417). These use
// fake trees with a delete() spy to assert exactly-once release on each path.
// Paths are virtual: set()/get() stat the file for mtime and tolerate ENOENT.

function fakeTree() {
	return { delete: vi.fn(), rootNode: { type: "program" } };
}

describe("TreeCache frees WASM trees on removal (#417)", () => {
	it("frees the oldest tree when evicting a full cache", () => {
		const cache = new TreeCache(2);
		const a = fakeTree();
		const b = fakeTree();
		const c = fakeTree();
		cache.set("a.ts", "a", "typescript", a);
		cache.set("b.ts", "b", "typescript", b);
		cache.set("c.ts", "c", "typescript", c); // evicts oldest (a)

		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).not.toHaveBeenCalled();
		expect(c.delete).not.toHaveBeenCalled();
	});

	it("frees the superseded tree when re-parsing the same file (same key)", () => {
		const cache = new TreeCache(10);
		const old = fakeTree();
		const fresh = fakeTree();
		cache.set("x.ts", "v1", "typescript", old);
		cache.set("x.ts", "v2", "typescript", fresh); // overwrite same key

		expect(old.delete).toHaveBeenCalledTimes(1);
		expect(fresh.delete).not.toHaveBeenCalled();
	});

	it("frees every tree on clear()", () => {
		const cache = new TreeCache(10);
		const a = fakeTree();
		const b = fakeTree();
		cache.set("a.ts", "a", "typescript", a);
		cache.set("b.ts", "b", "typescript", b);
		cache.clear();

		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).toHaveBeenCalledTimes(1);
	});

	it("frees the tree on invalidate()", () => {
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set("a.ts", "a", "typescript", a);
		cache.invalidate("a.ts", "typescript");

		expect(a.delete).toHaveBeenCalledTimes(1);
	});

	it("does NOT free the tree when content changed (kept for incremental)", () => {
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set("a.ts", "original", "typescript", a);
		// Different content ⇒ cache miss, but the tree is retained for a potential
		// incremental reparse — it must not be deleted out from under that path.
		const hit = cache.get("a.ts", "changed content", "typescript");

		expect(hit).toBeNull();
		expect(a.delete).not.toHaveBeenCalled();
	});

	it("never double-frees an already-evicted tree", () => {
		const cache = new TreeCache(1);
		const a = fakeTree();
		const b = fakeTree();
		cache.set("a.ts", "a", "typescript", a); // a cached
		cache.set("b.ts", "b", "typescript", b); // evicts a → a freed once
		cache.clear(); // frees b only; a is gone

		expect(a.delete).toHaveBeenCalledTimes(1);
		expect(b.delete).toHaveBeenCalledTimes(1);
	});

	it("frees the tree when the file changed on disk (mtime bump)", () => {
		const env = setupTestEnvironment("pi-lens-tccache-mtime-");
		cleanups.push(env.cleanup);
		const src = "export const x = 1;\n";
		const file = createTempFile(env.tmpDir, "m.ts", src);
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set(file, src, "typescript", a);

		// Same content (hash matches) but a newer mtime ⇒ get() must invalidate+free.
		const future = new Date(Date.now() + 5000);
		fs.utimesSync(file, future, future);

		expect(cache.get(file, src, "typescript")).toBeNull();
		expect(a.delete).toHaveBeenCalledTimes(1);
	});

	it("frees the tree when the file was deleted on disk", () => {
		const env = setupTestEnvironment("pi-lens-tccache-del-");
		cleanups.push(env.cleanup);
		const src = "export const y = 2;\n";
		const file = createTempFile(env.tmpDir, "d.ts", src);
		const cache = new TreeCache(10);
		const a = fakeTree();
		cache.set(file, src, "typescript", a);

		fs.rmSync(file);

		expect(cache.get(file, src, "typescript")).toBeNull();
		expect(a.delete).toHaveBeenCalledTimes(1);
	});

	it("frees the superseded tree after an incremental update", async () => {
		const cache = new TreeCache(10);
		// incrementalUpdate only engages for large files (>100 lines) with a diff.
		const oldContent = Array.from(
			{ length: 120 },
			(_, i) => `const a${i} = ${i};`,
		).join("\n");
		const newContent = `${oldContent}\nconst extra = 1;`;

		const oldTree = { edit: vi.fn(), delete: vi.fn() };
		const newTree = { delete: vi.fn() };
		const parser = { parse: vi.fn(() => newTree) };

		cache.set("big.ts", oldContent, "typescript", oldTree);

		const result = await cache.incrementalUpdate(
			"big.ts",
			oldContent,
			newContent,
			"typescript",
			parser,
		);

		// Reparse used the edited old tree, then the old tree is freed as it's
		// replaced in the cache; the new tree is cached (not freed).
		expect(result).toBe(newTree);
		expect(oldTree.edit).toHaveBeenCalledTimes(1);
		expect(parser.parse).toHaveBeenCalledWith(newContent, oldTree);
		expect(oldTree.delete).toHaveBeenCalledTimes(1);
		expect(newTree.delete).not.toHaveBeenCalled();

		// The new tree is now the cached entry — clearing frees exactly it.
		cache.clear();
		expect(newTree.delete).toHaveBeenCalledTimes(1);
	});

	it("survives a tree whose delete() throws (dead/aborted runtime)", () => {
		const cache = new TreeCache(1);
		const boom = { delete: vi.fn(() => { throw new Error("Aborted()"); }) };
		const next = fakeTree();
		cache.set("a.ts", "a", "typescript", boom);
		expect(() => cache.set("b.ts", "b", "typescript", next)).not.toThrow();
		expect(boom.delete).toHaveBeenCalledTimes(1);
	});
});
