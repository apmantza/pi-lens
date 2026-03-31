/**
 * FileTime Tracking Tests
 *
 * Tests the safety mechanism that prevents race conditions
 * between auto-formatting and agent edits.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileTime, FileTimeError, createFileTime, clearAllSessions } from "../file-time.js";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DIR = path.join(__dirname, "..", "..", "test-filetime");

describe("FileTime", () => {
	let fileTime: FileTime;
	const sessionID = "test-session";

	beforeEach(() => {
		clearAllSessions();
		fileTime = new FileTime(sessionID);
		
		// Ensure test directory exists
		if (!fs.existsSync(TEST_DIR)) {
			fs.mkdirSync(TEST_DIR, { recursive: true });
		}
	});

	describe("read()", () => {
		it("should record file stamp with mtime/ctime/size", () => {
			const testFile = path.join(TEST_DIR, "test1.txt");
			fs.writeFileSync(testFile, "hello");

			const stamp = fileTime.read(testFile);

			expect(stamp.readAt).toBeInstanceOf(Date);
			expect(stamp.mtime).toBeDefined();
			expect(stamp.ctime).toBeDefined();
			expect(stamp.size).toBe(5);
		});

		it("should handle non-existent files gracefully", () => {
			const testFile = path.join(TEST_DIR, "nonexistent.txt");

			const stamp = fileTime.read(testFile);

			expect(stamp.readAt).toBeInstanceOf(Date);
			expect(stamp.mtime).toBeUndefined();
			expect(stamp.ctime).toBeUndefined();
			expect(stamp.size).toBeUndefined();
		});

		it("should track multiple files per session", () => {
			const file1 = path.join(TEST_DIR, "file1.txt");
			const file2 = path.join(TEST_DIR, "file2.txt");
			fs.writeFileSync(file1, "content1");
			fs.writeFileSync(file2, "content2");

			fileTime.read(file1);
			fileTime.read(file2);

			expect(fileTime.get(file1)).toBeDefined();
			expect(fileTime.get(file2)).toBeDefined();
		});
	});

	describe("get()", () => {
		it("should return undefined for unread files", () => {
			const testFile = path.join(TEST_DIR, "unread.txt");

			const stamp = fileTime.get(testFile);

			expect(stamp).toBeUndefined();
		});

		it("should return recorded stamp for read files", () => {
			const testFile = path.join(TEST_DIR, "test2.txt");
			fs.writeFileSync(testFile, "content");
			const recorded = fileTime.read(testFile);

			const retrieved = fileTime.get(testFile);

			expect(retrieved?.mtime).toBe(recorded.mtime);
			expect(retrieved?.ctime).toBe(recorded.ctime);
			expect(retrieved?.size).toBe(recorded.size);
		});
	});

	describe("assert()", () => {
		it("should throw FileTimeError for unread files", () => {
			const testFile = path.join(TEST_DIR, "never-read.txt");
			fs.writeFileSync(testFile, "content");

			expect(() => fileTime.assert(testFile)).toThrow(FileTimeError);
			expect(() => fileTime.assert(testFile)).toThrow(/must read file/);
		});

		it("should not throw for unchanged files", () => {
			const testFile = path.join(TEST_DIR, "unchanged.txt");
			fs.writeFileSync(testFile, "content");
			fileTime.read(testFile);

			expect(() => fileTime.assert(testFile)).not.toThrow();
		});

		it("should throw FileTimeError when file modified externally", () => {
			const testFile = path.join(TEST_DIR, "modified.txt");
			fs.writeFileSync(testFile, "original");
			fileTime.read(testFile);

			// Simulate external modification
			fs.writeFileSync(testFile, "modified content");

			expect(() => fileTime.assert(testFile)).toThrow(FileTimeError);
			expect(() => fileTime.assert(testFile)).toThrow(/modified since it was last read/);
		});

		it("should detect size changes", () => {
			const testFile = path.join(TEST_DIR, "size-change.txt");
			fs.writeFileSync(testFile, "original content");
			fileTime.read(testFile);

			// Truncate file (size change, mtime change)
			fs.writeFileSync(testFile, "x");

			expect(() => fileTime.assert(testFile)).toThrow(FileTimeError);
		});
	});

	describe("hasChanged()", () => {
		it("should return true for unread files", () => {
			const testFile = path.join(TEST_DIR, "unread-check.txt");
			fs.writeFileSync(testFile, "content");

			expect(fileTime.hasChanged(testFile)).toBe(true);
		});

		it("should return false for unchanged files", () => {
			const testFile = path.join(TEST_DIR, "unchanged-check.txt");
			fs.writeFileSync(testFile, "content");
			fileTime.read(testFile);

			expect(fileTime.hasChanged(testFile)).toBe(false);
		});

		it("should return true when file modified", () => {
			const testFile = path.join(TEST_DIR, "changed-check.txt");
			fs.writeFileSync(testFile, "original");
			fileTime.read(testFile);

			fs.writeFileSync(testFile, "changed");

			expect(fileTime.hasChanged(testFile)).toBe(true);
		});
	});

	describe("withLock()", () => {
		it("should execute function exclusively", async () => {
			const testFile = path.join(TEST_DIR, "locked.txt");
			const executionOrder: string[] = [];

			const fn1 = async () => {
				executionOrder.push("start1");
				await new Promise(r => setTimeout(r, 50));
				executionOrder.push("end1");
				return "result1";
			};

			const fn2 = async () => {
				executionOrder.push("start2");
				await new Promise(r => setTimeout(r, 50));
				executionOrder.push("end2");
				return "result2";
			};

			// Start both, but they should execute sequentially
			const promise1 = fileTime.withLock(testFile, fn1);
			const promise2 = fileTime.withLock(testFile, fn2);

			await Promise.all([promise1, promise2]);

			// Should be sequential, not interleaved
			expect(executionOrder).toEqual(["start1", "end1", "start2", "end2"]);
		});

		it("should return function result", async () => {
			const testFile = path.join(TEST_DIR, "lock-result.txt");

			const result = await fileTime.withLock(testFile, async () => {
				return "success";
			});

			expect(result).toBe("success");
		});
	});

	describe("clear()", () => {
		it("should clear all tracked files for session", () => {
			const file1 = path.join(TEST_DIR, "clear1.txt");
			const file2 = path.join(TEST_DIR, "clear2.txt");
			fs.writeFileSync(file1, "a");
			fs.writeFileSync(file2, "b");
			fileTime.read(file1);
			fileTime.read(file2);

			fileTime.clear();

			expect(fileTime.get(file1)).toBeUndefined();
			expect(fileTime.get(file2)).toBeUndefined();
		});
	});

	describe("cross-session isolation", () => {
		it("should isolate file tracking between sessions", () => {
			const testFile = path.join(TEST_DIR, "isolated.txt");
			fs.writeFileSync(testFile, "content");

			const session1 = new FileTime("session1");
			const session2 = new FileTime("session2");

			session1.read(testFile);

			// session2 should not see session1's reads
			expect(() => session2.assert(testFile)).toThrow(FileTimeError);
			expect(() => session2.assert(testFile)).toThrow(/must read file/);
		});
	});

	describe("FileTimeError", () => {
		it("should have correct error properties", () => {
			const testFile = path.join(TEST_DIR, "error.txt");
			fs.writeFileSync(testFile, "content");

			try {
				fileTime.assert(testFile);
			} catch (error) {
				expect(error).toBeInstanceOf(FileTimeError);
				expect((error as FileTimeError).name).toBe("FileTimeError");
				expect((error as FileTimeError).filePath).toBe(path.resolve(testFile));
				expect((error as FileTimeError).reason).toBe("not-read");
			}
		});
	});
});

describe("createFileTime helper", () => {
	it("should create FileTime instance with session ID", () => {
		const ft = createFileTime("my-session");
		expect(ft).toBeInstanceOf(FileTime);
	});
});

describe("clearAllSessions helper", () => {
	it("should clear all session tracking", () => {
		const ft1 = createFileTime("session1");
		const ft2 = createFileTime("session2");
		const testFile = path.join(TEST_DIR, "clearall.txt");
		fs.writeFileSync(testFile, "x");

		ft1.read(testFile);
		ft2.read(testFile);

		clearAllSessions();

		// After clearing, both should throw "not read"
		const ft1New = createFileTime("session1");
		const ft2New = createFileTime("session2");
		expect(() => ft1New.assert(testFile)).toThrow(/must read file/);
		expect(() => ft2New.assert(testFile)).toThrow(/must read file/);
	});
});
