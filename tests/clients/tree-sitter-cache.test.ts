import { describe, expect, it, vi } from "vitest";
import { TreeCache } from "../../clients/tree-sitter-cache.js";

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

	it("survives a tree whose delete() throws (dead/aborted runtime)", () => {
		const cache = new TreeCache(1);
		const boom = { delete: vi.fn(() => { throw new Error("Aborted()"); }) };
		const next = fakeTree();
		cache.set("a.ts", "a", "typescript", boom);
		expect(() => cache.set("b.ts", "b", "typescript", next)).not.toThrow();
		expect(boom.delete).toHaveBeenCalledTimes(1);
	});
});
