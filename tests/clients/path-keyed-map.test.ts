/**
 * #1025 — the typed `PathKeyedMap<V>` primitive that folds every key through a
 * caller-supplied normalizer internally, so keying a raw (non-normalized) path
 * is structurally impossible (the path-key divergence class, follow-up to
 * #1020/#210).
 *
 * These tests are intentionally PLATFORM-INDEPENDENT: they feed two literal key
 * strings that differ only by separator/case to the SAME normalizer, so they
 * never touch the real filesystem and never assume a case-sensitive vs
 * case-insensitive OS (the #1024 trap). Separator folding is asserted with a
 * normalizer that folds unconditionally; case folding is asserted with a
 * lowercasing normalizer — both hold identically on Linux CI and Windows.
 */

import { describe, expect, it } from "vitest";
import { PathKeyedMap } from "../../clients/path-keyed-map.js";

// Unconditional slash-fold + lowercase normalizer — deterministic on every OS
// so the divergence-collapse assertions don't depend on `process.platform`.
const fold = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

describe("PathKeyedMap", () => {
	it("normalizes on set + get (mixed separators and case collapse to one lookup)", () => {
		const map = new PathKeyedMap<number>(fold);
		map.set("SUB\\A.ts", 1);
		expect(map.get("sub/a.ts")).toBe(1);
		expect(map.get("SUB/A.TS")).toBe(1);
		expect(map.get("sub\\a.ts")).toBe(1);
	});

	it("normalizes on has", () => {
		const map = new PathKeyedMap<number>(fold);
		map.set("Dir/File.ts", 7);
		expect(map.has("dir\\file.ts")).toBe(true);
		expect(map.has("other.ts")).toBe(false);
	});

	it("normalizes on delete", () => {
		const map = new PathKeyedMap<number>(fold);
		map.set("Dir/File.ts", 7);
		expect(map.delete("dir\\file.ts")).toBe(true);
		expect(map.has("Dir/File.ts")).toBe(false);
		expect(map.size).toBe(0);
	});

	it("deletes a captured display key when normalization changes after file removal", () => {
		let exists = true;
		const map = new PathKeyedMap<number>((p) =>
			exists ? p.toUpperCase() : p.toLowerCase(),
		);
		map.set("MixedCase_Test.go", 7);
		exists = false;

		expect(map.delete("MixedCase_Test.go")).toBe(true);
		expect(map.size).toBe(0);
	});

	it("two differently-formed keys for the same path collapse to ONE entry", () => {
		const map = new PathKeyedMap<number>(fold);
		map.set("SUB\\a.ts", 1);
		map.set("sub/a.ts", 2); // same normalized path — overwrites, does not add
		expect(map.size).toBe(1);
		expect(map.get("sub\\a.ts")).toBe(2);
	});

	it("retains the ORIGINAL (last-written) display path on iteration", () => {
		const map = new PathKeyedMap<number>(fold);
		map.set("SUB\\a.ts", 1);
		expect([...map.keys()]).toEqual(["SUB\\a.ts"]);
		// last-writer-wins refreshes the display path to the most recent form
		map.set("sub/a.ts", 2);
		expect([...map.keys()]).toEqual(["sub/a.ts"]);
		expect([...map.entries()]).toEqual([["sub/a.ts", 2]]);
		expect([...map.values()]).toEqual([2]);
	});

	it("forEach and the default iterator yield the display path", () => {
		const map = new PathKeyedMap<number>(fold);
		map.set("A/One.ts", 1);
		map.set("B/Two.ts", 2);

		const seenForEach: Array<[string, number]> = [];
		map.forEach((value, p) => seenForEach.push([p, value]));
		expect(seenForEach).toEqual([
			["A/One.ts", 1],
			["B/Two.ts", 2],
		]);

		expect([...map]).toEqual([
			["A/One.ts", 1],
			["B/Two.ts", 2],
		]);
	});

	it("clear empties the map", () => {
		const map = new PathKeyedMap<number>(fold);
		map.set("a.ts", 1);
		map.set("b.ts", 2);
		map.clear();
		expect(map.size).toBe(0);
		expect(map.get("a.ts")).toBeUndefined();
	});

	it("an identity normalizer degrades to a plain path-string map", () => {
		const map = new PathKeyedMap<number>((p) => p);
		map.set("SUB/a.ts", 1);
		map.set("sub/a.ts", 2);
		// no folding — these are distinct keys
		expect(map.size).toBe(2);
	});
});
