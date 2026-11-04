/**
 * #2219 (the #2141 class): `logActionableWarningsEvent`'s `filePath` is fed
 * a raw `path.resolve(cwd, file)` value from `actionable-warnings.ts`.
 * Mirrors `review-graph-logger.test.ts`'s mock-the-writer pattern: asserts
 * the single emit seam folds a raw path into the canonical form, that the
 * optional field is left absent when omitted, and that isTestMode still
 * gates the write.
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

import { logActionableWarningsEvent } from "../../clients/actionable-warnings-logger.js";
import { normalizeFilePath } from "../../clients/path-utils.js";

describe("actionable-warnings-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
		isTestModeRef.value = false;
	});

	it("normalizes a backslash-supplied filePath to the canonical slash form (#2141 class)", () => {
		logActionableWarningsEvent({
			event: "lsp_file_checked",
			filePath: "C:\\Users\\dev\\pi-free\\src\\a.ts",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0].filePath).toBe(
			normalizeFilePath("C:\\Users\\dev\\pi-free\\src\\a.ts"),
		);
	});

	it("leaves filePath absent when the event carries none (report_started)", () => {
		logActionableWarningsEvent({ event: "report_started" });

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect("filePath" in writerLog.mock.calls[0][0]).toBe(false);
	});

	it("is a no-op inside the test runner (isTestMode gate)", () => {
		isTestModeRef.value = true;
		logActionableWarningsEvent({ event: "report_started" });
		expect(writerLog).not.toHaveBeenCalled();
	});
});
