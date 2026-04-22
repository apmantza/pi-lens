/**
 * Format Service Tests
 *
 * Tests the FormatService class with mocked formatters.
 * Uses real temp files for FileTime integration but mocks
 * formatter execution to avoid real tool spawning.
 */

import * as fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearFormatServiceAndFileState,
	FormatService,
	getFormatService,
	resetFormatService,
} from "../../clients/format-service.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Mock formatters module to avoid real tool execution
vi.mock("../../clients/formatters.js", () => ({
	getFormattersForFile: vi.fn(),
	formatFile: vi.fn(),
	clearFormatterRuntimeState: vi.fn(),
	listAllFormatters: vi.fn().mockReturnValue(["biome", "prettier"]),
	biomeFormatter: { name: "biome", command: [], extensions: [".ts"] },
	prettierFormatter: { name: "prettier", command: [], extensions: [".ts"] },
}));

import { formatFile, getFormattersForFile } from "../../clients/formatters.js";

describe("FormatService", () => {
	beforeEach(() => {
		resetFormatService();
		vi.mocked(getFormattersForFile).mockReset();
		vi.mocked(formatFile).mockReset();
	});

	it("returns empty result when disabled", async () => {
		const service = new FormatService("test", false);
		const result = await service.formatFile("/any/path.ts");

		expect(result.formatters).toEqual([]);
		expect(result.anyChanged).toBe(false);
		expect(result.allSucceeded).toBe(true);
	});

	it("returns empty result when skip option is set", async () => {
		const service = new FormatService("test", true);
		const result = await service.formatFile("/any/path.ts", { skip: true });

		expect(result.formatters).toEqual([]);
		expect(result.anyChanged).toBe(false);
		expect(result.allSucceeded).toBe(true);
	});

	it("returns empty result when no formatters match", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment();
		const filePath = createTempFile(tmpDir, "app.ts", "const x=1");
		vi.mocked(getFormattersForFile).mockResolvedValue([]);

		const service = new FormatService("test", true);
		service.recordRead(filePath);
		const result = await service.formatFile(filePath);

		expect(result.formatters).toEqual([]);
		expect(result.anyChanged).toBe(false);
		expect(result.allSucceeded).toBe(true);
		cleanup();
	});

	it("runs formatters and reports changes", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment();
		const filePath = createTempFile(tmpDir, "app.ts", "const x=1");
		vi.mocked(getFormattersForFile).mockResolvedValue([
			{
				name: "biome",
				command: [],
				extensions: [".ts"],
				detect: async () => true,
			},
		]);
		vi.mocked(formatFile).mockResolvedValue({
			success: true,
			changed: true,
		});

		const service = new FormatService("test", true);
		service.recordRead(filePath);
		const result = await service.formatFile(filePath);

		expect(result.anyChanged).toBe(true);
		expect(result.allSucceeded).toBe(true);
		expect(result.formatters).toHaveLength(1);
		expect(result.formatters[0]).toMatchObject({
			name: "biome",
			success: true,
			changed: true,
		});
		cleanup();
	});

	it("reports failure when formatter errors", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment();
		const filePath = createTempFile(tmpDir, "app.ts", "const x=1");
		vi.mocked(getFormattersForFile).mockResolvedValue([
			{
				name: "biome",
				command: [],
				extensions: [".ts"],
				detect: async () => true,
			},
		]);
		vi.mocked(formatFile).mockResolvedValue({
			success: false,
			changed: false,
			error: "spawn error",
		});

		const service = new FormatService("test", true);
		service.recordRead(filePath);
		const result = await service.formatFile(filePath);

		expect(result.anyChanged).toBe(false);
		expect(result.allSucceeded).toBe(false);
		expect(result.formatters[0].error).toBe("spawn error");
		cleanup();
	});

	it("skips format when file changed externally", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment();
		const filePath = createTempFile(tmpDir, "app.ts", "const x=1");

		const service = new FormatService("test", true);
		// Record read, then modify file externally
		service.recordRead(filePath);
		// Small delay to ensure mtime changes
		await new Promise((r) => setTimeout(r, 10));
		fs.writeFileSync(filePath, "const x = 2;");

		const result = await service.formatFile(filePath);

		expect(result.allSucceeded).toBe(false);
		expect(result.formatters).toEqual([]);
		cleanup();
	});

	it("getFormatService returns singleton per session", () => {
		const s1 = getFormatService("session-a", true);
		const s2 = getFormatService("session-a", true);
		const s3 = getFormatService("session-b", true);

		expect(s1).toBe(s2);
		expect(s1).not.toBe(s3);
	});

	it("resetFormatService clears singleton", () => {
		const s1 = getFormatService("session-a", true);
		resetFormatService();
		const s2 = getFormatService("session-a", true);

		expect(s1).not.toBe(s2);
	});

	it("clearFormatServiceAndFileState clears all state", () => {
		new FormatService("test", true);
		expect(() => clearFormatServiceAndFileState()).not.toThrow();
	});

	it("recordRead and hasChanged track file state", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment();
		const filePath = createTempFile(tmpDir, "app.ts", "const x=1");

		const service = new FormatService("test", true);
		expect(service.hasChanged(filePath)).toBe(true); // never read

		service.recordRead(filePath);
		expect(service.hasChanged(filePath)).toBe(false);

		await new Promise((r) => setTimeout(r, 10));
		fs.writeFileSync(filePath, "const x = 2;");
		expect(service.hasChanged(filePath)).toBe(true);

		cleanup();
	});

	it("assertUnchanged throws when file modified externally", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment();
		const filePath = createTempFile(tmpDir, "app.ts", "const x=1");

		const service = new FormatService("test", true);
		service.recordRead(filePath);
		await new Promise((r) => setTimeout(r, 10));
		fs.writeFileSync(filePath, "const x = 2;");

		expect(() => service.assertUnchanged(filePath)).toThrow();
		cleanup();
	});
});
