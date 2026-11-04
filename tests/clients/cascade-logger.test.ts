/**
 * #2219 (the #2141 class): `logCascade` call sites across
 * `dispatch/integration.ts`, `runtime-turn.ts`, and `runtime-coordinator.ts`
 * feed a mix of raw `filePath`/`cwd` params, while `lsp/cascade-tier.ts`
 * feeds the `"<quiet-window>"` sentinel on the same field. Mirrors
 * `review-graph-logger.test.ts`'s mock-the-writer pattern: asserts the
 * single emit seam folds a raw path into the canonical form, AND that the
 * non-path sentinel passes through untouched instead of being resolved
 * against the process cwd.
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

import { logCascade } from "../../clients/cascade-logger.js";
import { normalizeFilePath } from "../../clients/path-utils.js";

describe("cascade-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
		isTestModeRef.value = false;
	});

	it("normalizes a backslash-supplied filePath to the canonical slash form (#2141 class)", () => {
		logCascade({
			phase: "cascade_skip",
			filePath: "C:\\Users\\dev\\pi-free\\src\\a.ts",
			reason: "primary_has_blockers",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0].filePath).toBe(
			normalizeFilePath("C:\\Users\\dev\\pi-free\\src\\a.ts"),
		);
	});

	it("emits the same filePath form for a raw path and an already-normalized one", () => {
		logCascade({
			phase: "cascade_skip",
			filePath: "C:\\Users\\dev\\pi-free\\src\\a.ts",
			reason: "non_code_file",
		});
		logCascade({
			phase: "graph_build",
			filePath: normalizeFilePath("C:\\Users\\dev\\pi-free\\src\\a.ts"),
		});

		expect(writerLog).toHaveBeenCalledTimes(2);
		expect(writerLog.mock.calls[0][0].filePath).toBe(
			writerLog.mock.calls[1][0].filePath,
		);
	});

	it("passes a non-path sentinel through unchanged instead of resolving it against cwd", () => {
		logCascade({
			phase: "cascade_tier3_reconcile",
			filePath: "<quiet-window>",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0].filePath).toBe("<quiet-window>");
	});

	it("is a no-op inside the test runner (isTestMode gate)", () => {
		isTestModeRef.value = true;
		logCascade({ phase: "cascade_skip", filePath: "/proj/a.ts" });
		expect(writerLog).not.toHaveBeenCalled();
	});
});
