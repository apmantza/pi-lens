/**
 * #2141: `logReviewGraph` call sites in `clients/review-graph/builder.ts` feed
 * a mix of raw `cwd` params and pre-normalized cache keys
 * (`normalizeMapKey(path.resolve(cwd))`), so the same project root showed up
 * in review-graph.log as both `C:\...\pi-free` (backslash) and
 * `C:/.../pi-free` (slash) within one dogfood window. This mirrors
 * word-index-logger.test.ts's mock-the-writer pattern so no real file is
 * touched, and asserts the single emit seam folds both spellings into one
 * canonical form.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const writerLog = vi.hoisted(() => vi.fn());
const isTestModeRef = vi.hoisted(() => ({ value: false }));

vi.mock("../../clients/env-utils.js", async (importOriginal) => ({
	// #5231: keep every real export; only the test-mode answer is doubled.
	...(await importOriginal<typeof import("../../clients/env-utils.js")>()),
	isTestMode: () => isTestModeRef.value,
}));
vi.mock("../../clients/ndjson-logger.js", () => ({
	createNdjsonLogger: () => ({
		log: writerLog,
		append: vi.fn(),
		truncate: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
		flushSync: vi.fn(),
	}),
}));

import { normalizeFilePath } from "../../clients/path-utils.js";
import { logReviewGraph } from "../../clients/review-graph-logger.js";

describe("review-graph-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
		isTestModeRef.value = false;
	});

	it("normalizes a backslash-supplied cwd to the canonical slash form (#2141)", () => {
		logReviewGraph({
			cwd: "C:\\Users\\dev\\pi-free",
			phase: "build_started",
			nodes: 0,
			edges: 0,
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0].cwd).toBe(
			normalizeFilePath("C:\\Users\\dev\\pi-free"),
		);
	});

	it("emits the same cwd form for a raw root and an already-normalized cache key (#2141)", () => {
		logReviewGraph({
			cwd: "C:\\Users\\dev\\pi-free",
			phase: "build_started",
			nodes: 0,
			edges: 0,
		});
		logReviewGraph({
			cwd: normalizeFilePath("C:\\Users\\dev\\pi-free"),
			phase: "build_succeeded",
			nodes: 1,
			edges: 0,
		});

		expect(writerLog).toHaveBeenCalledTimes(2);
		expect(writerLog.mock.calls[0][0].cwd).toBe(writerLog.mock.calls[1][0].cwd);
	});

	it("is a no-op inside the test runner (isTestMode gate)", () => {
		isTestModeRef.value = true;
		logReviewGraph({
			cwd: "/proj",
			phase: "build_failed",
			nodes: 0,
			edges: 0,
		});
		expect(writerLog).not.toHaveBeenCalled();
	});
});
