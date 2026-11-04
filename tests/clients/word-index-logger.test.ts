/**
 * #926 durable word-index reporting, extended for #958. Verifies the shared
 * NDJSON writer forwarding + the `isTestMode()` gate, mirroring
 * latency-logger.test.ts's mock-the-writer pattern so no real file is touched.
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
import { logWordIndex } from "../../clients/word-index-logger.js";

describe("word-index-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
		isTestModeRef.value = false;
	});

	it("stamps ts and forwards the structured decision/coverage fields", () => {
		logWordIndex({
			phase: "incremental_refresh",
			cwd: "/proj",
			trigger: "session_start",
			indexedFileCount: 42,
			truncated: false,
			refreshed: 3,
			dropped: 1,
			skipped: 0,
			reused: 38,
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				phase: "incremental_refresh",
				cwd: normalizeFilePath("/proj"),
				indexedFileCount: 42,
				refreshed: 3,
				reused: 38,
				ts: expect.any(String),
			}),
		);
	});

	it("is a no-op inside the test runner (isTestMode gate)", () => {
		isTestModeRef.value = true;
		logWordIndex({ phase: "persist_failed", cwd: "/proj", error: "boom" });
		expect(writerLog).not.toHaveBeenCalled();
	});

	// #2141 class sweep: this logger mixes raw roots (`snapshotRoot`,
	// `path.resolve(cwd)`) and pre-normalized cache keys (`key`) across call
	// sites, so the same root could reach the log in two path forms. The single
	// emit seam must fold both into one canonical form.
	it("normalizes a backslash-supplied cwd to the same form as an already-normalized one (#2141)", () => {
		logWordIndex({
			phase: "full_rebuild",
			cwd: "C:\\Users\\dev\\pi-free",
			trigger: "session_start",
			indexedFileCount: 1,
		});
		logWordIndex({
			phase: "full_rebuild",
			cwd: "C:/Users/dev/pi-free",
			trigger: "session_start",
			indexedFileCount: 1,
		});

		expect(writerLog).toHaveBeenCalledTimes(2);
		const [firstCwd] = [writerLog.mock.calls[0][0].cwd];
		const [secondCwd] = [writerLog.mock.calls[1][0].cwd];
		expect(firstCwd).toBe(secondCwd);
	});
});
