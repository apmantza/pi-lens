import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CacheManager,
	type ModifiedRange,
	type TurnState,
} from "./cache-manager.js";

describe("CacheManager", () => {
	let manager: CacheManager;
	let testDir: string;

	beforeEach(() => {
		manager = new CacheManager();
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cache-test-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	describe("scanner cache", () => {
		it("should return null for missing cache", () => {
			const result = manager.readCache("knip", testDir);
			expect(result).toBeNull();
		});

		it("should write and read cache", () => {
			const data = { files: ["a.ts", "b.ts"], unused: ["x"] };
			manager.writeCache("knip", data, testDir, { scanDurationMs: 1500 });

			const result = manager.readCache<typeof data>("knip", testDir);
			expect(result).not.toBeNull();
			expect(result?.data).toEqual(data);
			expect(result?.meta.scanDurationMs).toBe(1500);
			expect(result?.meta.timestamp).toBeDefined();
		});

		it("should return null for stale cache", () => {
			const data = { files: [] };
			manager.writeCache("jscpd", data, testDir);

			// Manually set old timestamp
			const metaPath = path.join(
				testDir,
				".pi-lens",
				"cache",
				"jscpd.meta.json",
			);
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			meta.timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
			fs.writeFileSync(metaPath, JSON.stringify(meta));

			const result = manager.readCache("jscpd", testDir, 30 * 60 * 1000);
			expect(result).toBeNull();
		});

		it("should respect custom maxAge", () => {
			const data = { files: [] };
			manager.writeCache("madge", data, testDir);

			// Cache is 45 min old
			const metaPath = path.join(
				testDir,
				".pi-lens",
				"cache",
				"madge.meta.json",
			);
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			meta.timestamp = new Date(Date.now() - 45 * 60 * 1000).toISOString();
			fs.writeFileSync(metaPath, JSON.stringify(meta));

			// Default 30 min → stale
			expect(manager.readCache("madge", testDir)).toBeNull();

			// Custom 60 min → fresh
			const result = manager.readCache("madge", testDir, 60 * 60 * 1000);
			expect(result).not.toBeNull();
		});

		it("should check cache freshness", () => {
			expect(manager.isCacheFresh("knip", testDir)).toBe(false);

			manager.writeCache("knip", {}, testDir);
			expect(manager.isCacheFresh("knip", testDir)).toBe(true);
		});

		it("should clear cache", () => {
			manager.writeCache("jscpd", { clones: [] }, testDir);
			expect(manager.isCacheFresh("jscpd", testDir)).toBe(true);

			manager.clearCache("jscpd", testDir);
			expect(manager.isCacheFresh("jscpd", testDir)).toBe(false);
		});
	});

	// Helper to get test file path (absolute)
	const testFile = (name: string) => path.join(testDir, name);

	describe("turn state", () => {
		it("should return default state when no file exists", () => {
			const state = manager.readTurnState(testDir);
			expect(state.files).toEqual({});
			expect(state.turnCycles).toBe(0);
			expect(state.maxCycles).toBe(3);
		});

		it("should write and read turn state", () => {
			const state: TurnState = {
				files: {
					"src/a.ts": {
						modifiedRanges: [{ start: 1, end: 10 }],
						importsChanged: true,
						lastEdit: new Date().toISOString(),
					},
				},
				turnCycles: 1,
				maxCycles: 3,
				lastUpdated: "",
			};

			manager.writeTurnState(state, testDir);
			const read = manager.readTurnState(testDir);

			expect(read.turnCycles).toBe(1);
			expect(read.files["src/a.ts"].modifiedRanges).toHaveLength(1);
		});

		it("should add modified ranges and merge overlapping", () => {
			manager.addModifiedRange(
				testFile("src/a.ts"),
				{ start: 1, end: 10 },
				false,
				testDir,
			);
			manager.addModifiedRange(
				testFile("src/a.ts"),
				{ start: 8, end: 20 },
				true,
				testDir,
			);

			const state = manager.readTurnState(testDir);
			const key = "src/a.ts";
			const ranges = state.files[key]?.modifiedRanges;

			expect(ranges).toHaveLength(1); // Merged into one
			expect(ranges?.[0]).toEqual({ start: 1, end: 20 });
			expect(state.files[key].importsChanged).toBe(true);
		});

		it("should track imports_changed flag", () => {
			// First edit without import change
			manager.addModifiedRange(
				testFile("src/a.ts"),
				{ start: 1, end: 5 },
				false,
				testDir,
			);

			// Second edit with import change
			manager.addModifiedRange(
				testFile("src/a.ts"),
				{ start: 10, end: 15 },
				true,
				testDir,
			);

			const state = manager.readTurnState(testDir);
			expect(state.files["src/a.ts"].importsChanged).toBe(true);
		});

		it("should increment turn cycle", () => {
			manager.incrementTurnCycle(testDir);
			manager.incrementTurnCycle(testDir);

			const state = manager.readTurnState(testDir);
			expect(state.turnCycles).toBe(2);
		});

		it("should detect max cycles exceeded", () => {
			expect(manager.isMaxCyclesExceeded(testDir)).toBe(false);

			manager.incrementTurnCycle(testDir);
			manager.incrementTurnCycle(testDir);
			manager.incrementTurnCycle(testDir);

			expect(manager.isMaxCyclesExceeded(testDir)).toBe(true);
		});

		it("should clear turn state", () => {
			manager.addModifiedRange(
				testFile("src/a.ts"),
				{ start: 1, end: 10 },
				true,
				testDir,
			);
			manager.incrementTurnCycle(testDir);

			manager.clearTurnState(testDir);

			const state = manager.readTurnState(testDir);
			expect(Object.keys(state.files)).toHaveLength(0);
			expect(state.turnCycles).toBe(0);
		});
	});

	describe("file queries", () => {
		beforeEach(() => {
			// Clear any previous state from other tests
			manager.clearTurnState(testDir);
			// Now add our test files
			manager.addModifiedRange(
				testFile("a.ts"),
				{ start: 1, end: 10 },
				false,
				testDir,
			);
			manager.addModifiedRange(
				testFile("b.ts"),
				{ start: 5, end: 20 },
				true,
				testDir,
			);
			manager.addModifiedRange(
				testFile("c.ts"),
				{ start: 1, end: 5 },
				true,
				testDir,
			);
		});

		it("should get all files for jscpd", () => {
			const files = manager.getFilesForJscpd(testDir);
			expect(files).toHaveLength(3);
		});

		it("should get only files with import changes for madge", () => {
			// Verify state was recorded correctly
			const state = manager.readTurnState(testDir);
			const fileKeys = Object.keys(state.files);

			// Only b.ts and c.ts have importsChanged: true
			const madgeFiles = manager.getFilesForMadge(testDir);
			const filesWithImportsTrue = fileKeys.filter(
				(k) => state.files[k].importsChanged,
			);

			expect(madgeFiles).toHaveLength(filesWithImportsTrue.length);
		});
	});

	describe("range utilities", () => {
		it("should merge non-overlapping ranges", () => {
			const ranges: ModifiedRange[] = [
				{ start: 1, end: 5 },
				{ start: 10, end: 15 },
				{ start: 20, end: 25 },
			];
			expect(manager.mergeRanges(ranges)).toHaveLength(3);
		});

		it("should merge overlapping ranges", () => {
			const ranges: ModifiedRange[] = [
				{ start: 1, end: 10 },
				{ start: 5, end: 15 },
			];
			const merged = manager.mergeRanges(ranges);
			expect(merged).toHaveLength(1);
			expect(merged[0]).toEqual({ start: 1, end: 15 });
		});

		it("should merge adjacent ranges", () => {
			const ranges: ModifiedRange[] = [
				{ start: 1, end: 10 },
				{ start: 11, end: 20 },
			];
			const merged = manager.mergeRanges(ranges);
			expect(merged).toHaveLength(1);
			expect(merged[0]).toEqual({ start: 1, end: 20 });
		});

		it("should detect line in modified range", () => {
			const ranges: ModifiedRange[] = [
				{ start: 10, end: 20 },
				{ start: 30, end: 40 },
			];

			expect(manager.isLineInModifiedRange(5, ranges)).toBe(false);
			expect(manager.isLineInModifiedRange(10, ranges)).toBe(true);
			expect(manager.isLineInModifiedRange(15, ranges)).toBe(true);
			expect(manager.isLineInModifiedRange(20, ranges)).toBe(true);
			expect(manager.isLineInModifiedRange(25, ranges)).toBe(false);
			expect(manager.isLineInModifiedRange(35, ranges)).toBe(true);
		});
	});
});
