/**
 * Format Service Tests
 *
 * Tests concurrent formatter execution via Effect-TS
 * and FileTime integration for safety.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { FormatService, getFormatService, resetFormatService } from "../format-service.js";
import { FileTimeError } from "../file-time.js";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DIR = path.join(__dirname, "..", "..", "test-format-service");

describe("FormatService", () => {
	let formatService: FormatService;
	const sessionID = "test-format-session";

	beforeEach(() => {
		resetFormatService();
		formatService = new FormatService(sessionID, true);
		
		if (fs.existsSync(TEST_DIR)) {
			fs.rmSync(TEST_DIR, { recursive: true });
		}
		fs.mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		resetFormatService();
		if (fs.existsSync(TEST_DIR)) {
			fs.rmSync(TEST_DIR, { recursive: true });
		}
	});

	describe("formatFile()", () => {
		it("should skip formatting when disabled", async () => {
			const disabledService = new FormatService(sessionID, false);
			const testFile = path.join(TEST_DIR, "disabled.txt");
			fs.writeFileSync(testFile, "content");

			const result = await disabledService.formatFile(testFile);

			expect(result.formatters).toEqual([]);
			expect(result.anyChanged).toBe(false);
			expect(result.allSucceeded).toBe(true);
		});

		it("should skip formatting with skip option", async () => {
			const testFile = path.join(TEST_DIR, "skipped.txt");
			fs.writeFileSync(testFile, "content");

			const result = await formatService.formatFile(testFile, { skip: true });

			expect(result.formatters).toEqual([]);
			expect(result.anyChanged).toBe(false);
			expect(result.allSucceeded).toBe(true);
		});

		it("should skip when file modified externally", async () => {
			const testFile = path.join(TEST_DIR, "external.txt");
			fs.writeFileSync(testFile, "original");
			
			// Record read
			formatService.recordRead(testFile);
			
			// Modify externally
			fs.writeFileSync(testFile, "modified");

			const result = await formatService.formatFile(testFile);

			expect(result.formatters).toEqual([]);
			expect(result.anyChanged).toBe(false);
			expect(result.allSucceeded).toBe(false);
		});

		it("should format TypeScript file with biome config", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), '{"formatter": {}}');
			const tsFile = path.join(TEST_DIR, "test.ts");
			fs.writeFileSync(tsFile, "const x=1;");
			
			// Record read so format service knows initial state
			formatService.recordRead(tsFile);

			const result = await formatService.formatFile(tsFile);

			expect(result.filePath).toBe(tsFile);
			expect(result.formatters.some(f => f.name === "biome")).toBe(true);
		});

		it("should format Python file with ruff config", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "pyproject.toml"),
				"[tool.ruff]\nline-length = 100"
			);
			const pyFile = path.join(TEST_DIR, "test.py");
			fs.writeFileSync(pyFile, "x=1");
			
			// Record read so format service knows initial state
			formatService.recordRead(pyFile);

			const result = await formatService.formatFile(pyFile);

			expect(result.filePath).toBe(pyFile);
			expect(result.formatters.some(f => f.name === "ruff")).toBe(true);
		});

		it("should run multiple formatters for same file", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			fs.writeFileSync(
				path.join(TEST_DIR, "package.json"),
				JSON.stringify({ devDependencies: { prettier: "^3.0.0" } })
			);
			const tsFile = path.join(TEST_DIR, "test.ts");
			fs.writeFileSync(tsFile, "const x = 1;");
			
			formatService.recordRead(tsFile);

			const result = await formatService.formatFile(tsFile);

			const names = result.formatters.map(f => f.name);
			expect(names).toContain("biome");
		});

		it("should return empty result for unsupported file", async () => {
			const txtFile = path.join(TEST_DIR, "test.txt");
			fs.writeFileSync(txtFile, "content");
			
			formatService.recordRead(txtFile);

			const result = await formatService.formatFile(txtFile);

			expect(result.formatters).toEqual([]);
			expect(result.anyChanged).toBe(false);
			expect(result.allSucceeded).toBe(true);
		});

		it("should record FileTime after formatting", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			const tsFile = path.join(TEST_DIR, "test.ts");
			fs.writeFileSync(tsFile, "const x = 1;");
			
			formatService.recordRead(tsFile);

			await formatService.formatFile(tsFile);

			expect(() => formatService.assertUnchanged(tsFile)).not.toThrow();
		});

		it("should report success/failure for each formatter", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			const tsFile = path.join(TEST_DIR, "test.ts");
			fs.writeFileSync(tsFile, "const x = 1;");
			
			formatService.recordRead(tsFile);

			const result = await formatService.formatFile(tsFile);

			for (const formatter of result.formatters) {
				expect(formatter).toHaveProperty("name");
				expect(formatter).toHaveProperty("success");
				expect(formatter).toHaveProperty("changed");
				expect(typeof formatter.success).toBe("boolean");
				expect(typeof formatter.changed).toBe("boolean");
			}
		});

		it("should re-read file content after formatting", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			const tsFile = path.join(TEST_DIR, "test.ts");
			fs.writeFileSync(tsFile, "const x = 1;");
			
			formatService.recordRead(tsFile);

			const result = await formatService.formatFile(tsFile);

			const after = fs.readFileSync(tsFile, "utf-8");
			expect(after).toBeDefined();
		});
	});

	describe("assertUnchanged()", () => {
		it("should not throw for unchanged files", async () => {
			const testFile = path.join(TEST_DIR, "unchanged.txt");
			fs.writeFileSync(testFile, "content");
			formatService.recordRead(testFile);

			expect(() => formatService.assertUnchanged(testFile)).not.toThrow();
		});

		it("should throw FileTimeError when file modified", async () => {
			const testFile = path.join(TEST_DIR, "modified.txt");
			fs.writeFileSync(testFile, "original");
			formatService.recordRead(testFile);

			fs.writeFileSync(testFile, "changed");

			expect(() => formatService.assertUnchanged(testFile)).toThrow(FileTimeError);
		});
	});

	describe("hasChanged()", () => {
		it("should return false for unchanged files", async () => {
			const testFile = path.join(TEST_DIR, "unchanged-check.txt");
			fs.writeFileSync(testFile, "content");
			formatService.recordRead(testFile);

			expect(formatService.hasChanged(testFile)).toBe(false);
		});

		it("should return true when file modified", async () => {
			const testFile = path.join(TEST_DIR, "changed-check.txt");
			fs.writeFileSync(testFile, "original");
			formatService.recordRead(testFile);

			// Small delay to ensure different mtime (Windows has ~16ms resolution)
			await new Promise(r => setTimeout(r, 50));
			fs.writeFileSync(testFile, "modified");

			expect(formatService.hasChanged(testFile)).toBe(true);
		});

		it("should return true for unread files", async () => {
			const testFile = path.join(TEST_DIR, "never-read.txt");
			fs.writeFileSync(testFile, "content");

			expect(formatService.hasChanged(testFile)).toBe(true);
		});
	});

	describe("recordRead()", () => {
		it("should record file read for tracking", async () => {
			const testFile = path.join(TEST_DIR, "tracked.txt");
			fs.writeFileSync(testFile, "content");

			formatService.recordRead(testFile);

			expect(formatService.hasChanged(testFile)).toBe(false);
		});
	});

	describe("clearCache()", () => {
		it("should clear formatter detection cache", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			const tsFile = path.join(TEST_DIR, "test.ts");
			fs.writeFileSync(tsFile, "const x = 1;");
			formatService.recordRead(tsFile);
			
			await formatService.formatFile(tsFile);

			formatService.clearCache();

			await formatService.formatFile(tsFile);
		});
	});

	describe("Concurrency", () => {
		it("should handle multiple files concurrently", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			
			const files = [
				path.join(TEST_DIR, "file1.ts"),
				path.join(TEST_DIR, "file2.ts"),
				path.join(TEST_DIR, "file3.ts"),
			];
			
			for (const file of files) {
				fs.writeFileSync(file, "const x = 1;");
				formatService.recordRead(file);
			}

			const results = await Promise.all(
				files.map(f => formatService.formatFile(f))
			);

			expect(results).toHaveLength(3);
			for (const result of results) {
				expect(result.filePath).toBeDefined();
				expect(result.formatters.length).toBeGreaterThan(0);
			}
		});
	});
});

describe("getFormatService singleton", () => {
	beforeEach(() => {
		resetFormatService();
	});

	afterEach(() => {
		resetFormatService();
	});

	it("should return singleton instance", () => {
		const instance1 = getFormatService();
		const instance2 = getFormatService();

		expect(instance1).toBe(instance2);
	});

	it("should create new instance when session ID provided", () => {
		const instance1 = getFormatService("session1");
		const instance2 = getFormatService("session2");

		expect(instance1).not.toBe(instance2);
	});

	it("should use cached instance regardless of enabled flag changes", () => {
		const first = getFormatService("test", true);
		const second = getFormatService("test", false);

		expect(first).toBe(second);
	});
});

describe("resetFormatService", () => {
	it("should reset singleton instance", () => {
		const instance1 = getFormatService();
		resetFormatService();
		const instance2 = getFormatService();

		expect(instance1).not.toBe(instance2);
	});
});
