import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeSitterParseCacheStats } from "../../clients/tree-sitter-client.js";

function stats(
	overrides: Partial<TreeSitterParseCacheStats> = {},
): TreeSitterParseCacheStats {
	return {
		size: 0,
		maxSize: 50,
		totalLines: 0,
		totalBytes: 0,
		lookups: 0,
		hits: 0,
		misses: 0,
		coldMisses: 0,
		capacityMisses: 0,
		contentChangedMisses: 0,
		mtimeMisses: 0,
		statFailedMisses: 0,
		sets: 0,
		replacements: 0,
		evictions: 0,
		clears: 0,
		ghostHistoryDrops: 0,
		parserInvocations: 0,
		parserDurationMs: 0,
		parserFailures: 0,
		...overrides,
	};
}

// Allow this test to exercise the real logger (it mocks fs, so no disk I/O).
process.env.PI_LENS_TEST_MODE = "0";

describe("tree-sitter-logger", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:os");
	});

	it("writes JSON line entries to tree-sitter.log", async () => {
		const appendFile = vi.fn(async (_file: string, _data: string) => {});

		vi.doMock("node:fs", () => ({
			mkdirSync: vi.fn(),
			statSync: () => {
				throw new Error("ENOENT");
			},
			promises: { appendFile },
		}));
		vi.doMock("node:os", () => ({
			homedir: () => "/mock-home",
		}));

		const mod = await import("../../clients/tree-sitter-logger.js");
		mod.logTreeSitter({
			phase: "runner_complete",
			filePath: "src/main.go",
			status: "succeeded",
			diagnostics: 2,
			blocking: 1,
		});

		// Buffered async write — await the exported flush before asserting.
		await mod.flushTreeSitterLog();

		expect(appendFile).toHaveBeenCalledTimes(1);
		const [filePath, payload] = appendFile.mock.calls[0];
		expect(filePath).toContain("tree-sitter.log");
		expect(payload).toContain('"phase":"runner_complete"');
		expect(payload).toContain('"filePath":"src/main.go"');
		expect(payload.endsWith("\n")).toBe(true);
		expect(mod.getTreeSitterLogPath()).toContain("tree-sitter.log");
	});

	it("writes aggregated cache stats", async () => {
		const appendFile = vi.fn(async (_file: string, _data: string) => {});
		vi.doMock("node:fs", () => ({
			mkdirSync: vi.fn(),
			statSync: () => {
				throw new Error("ENOENT");
			},
			promises: { appendFile },
		}));
		vi.doMock("node:os", () => ({
			homedir: () => "/mock-home",
		}));

		const mod = await import("../../clients/tree-sitter-logger.js");
		mod.logTreeSitterCacheStats({
			scope: "project_diagnostics_scan",
			filePath: "/workspace",
			fileCount: 3,
			durationMs: 25,
			stats: stats({
				size: 1,
				totalBytes: 128,
				totalLines: 8,
				lookups: 4,
				hits: 3,
				misses: 1,
				coldMisses: 1,
				sets: 1,
				parserInvocations: 1,
				parserDurationMs: 2.5,
			}),
			// #1982: the sub-field is required on every record — a scope that ran
			// an ast-grep pass reports its cost here (subtracted from durationMs
			// above); this test pins that it round-trips into the payload.
			astGrep: { durationMs: 7, fileCount: 2 },
		});
		await mod.flushTreeSitterLog();

		const payload = JSON.parse(appendFile.mock.calls[0][1]);
		expect(payload).toMatchObject({
			phase: "cache_stats",
			filePath: "/workspace",
			durationMs: 25,
			metadata: {
				scope: "project_diagnostics_scan",
				fileCount: 3,
				hitRate: 0.75,
				delta: {
					lookups: 4,
					hits: 3,
					coldMisses: 1,
					parserInvocations: 1,
					parserDurationMs: 2.5,
				},
				resident: { size: 1, maxSize: 50, totalBytes: 128, totalLines: 8 },
				astGrep: { durationMs: 7, fileCount: 2 },
			},
		});
	});

	it("swallows append errors", async () => {
		const appendFile = vi.fn(async () => {
			throw new Error("disk full");
		});

		vi.doMock("node:fs", () => ({
			mkdirSync: vi.fn(),
			statSync: () => {
				throw new Error("ENOENT");
			},
			promises: { appendFile },
		}));
		vi.doMock("node:os", () => ({
			homedir: () => "/mock-home",
		}));

		const mod = await import("../../clients/tree-sitter-logger.js");
		mod.logTreeSitter({ phase: "runner_start", filePath: "src/a.go" });
		// The swallowed rejection must not surface through flush().
		await expect(mod.flushTreeSitterLog()).resolves.toBeUndefined();
	});
});
