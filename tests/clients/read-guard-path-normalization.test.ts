/**
 * Regression: read-guard keyed its reads/edits maps on the raw file path, so a
 * read recorded under one separator/casing form (e.g. the slash-normalized path
 * that LSP-expanded and search-tool reads produce) was invisible to an edit
 * checked under another (the Read tool's OS-native backslashes on Windows). The
 * guard then reported `zero_read` and blocked the edit even though the file had
 * been read — repeatedly, in a real session (see read-guard.log: reads logged
 * with `C:/…` forward slashes, the blocking edit with `C:\\…` backslashes).
 *
 * The fix canonicalizes every map key through `normalizeFilePath`. These tests
 * pin that record and lookup agree regardless of the separator/casing the two
 * call sites happen to use.
 */

import { describe, expect, it, vi } from "vitest";
import { createReadGuard, type ReadRecord } from "../../clients/read-guard.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
	getReadGuardLogPath: vi.fn(() => "/dev/null"),
}));

vi.mock("../../clients/file-time.js", () => ({
	createFileTime: () => ({
		read: vi.fn(),
		hasChanged: vi.fn(() => false),
		assert: vi.fn(),
		get: vi.fn(),
	}),
}));

function rec(filePath: string, overrides: Partial<ReadRecord> = {}): ReadRecord {
	return {
		filePath,
		requestedOffset: 1,
		requestedLimit: 100,
		effectiveOffset: 1,
		effectiveLimit: 100,
		expandedByLsp: false,
		turnIndex: 1,
		writeIndex: 1,
		timestamp: Date.now(),
		...overrides,
	};
}

describe("ReadGuard path-key normalization (zero_read false-block regression)", () => {
	it("allows an edit checked with backslashes after a read recorded with forward slashes", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("/proj/providers/model-fetcher.ts"));

		const verdict = guard.checkEdit("\\proj\\providers\\model-fetcher.ts");

		expect(verdict.action).toBe("allow");
	});

	it("allows the reverse — read recorded with backslashes, edit checked with forward slashes", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("\\proj\\tests\\kilo.test.ts"));

		const verdict = guard.checkEdit("/proj/tests/kilo.test.ts");

		expect(verdict.action).toBe("allow");
	});

	it("getReadHistory matches across separator forms", () => {
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("/proj/a.ts"));

		expect(guard.getReadHistory("\\proj\\a.ts")).toHaveLength(1);
	});

	it("a once-recorded exemption is honored regardless of separator form", () => {
		const guard = createReadGuard("test-session");
		guard.addExemption("/proj/b.ts");

		expect(guard.checkEdit("\\proj\\b.ts").action).toBe("allow");
	});

	it("folds Windows path casing so cased read forms match lower-cased edits", () => {
		if (process.platform !== "win32") return; // case-insensitive only on Windows
		const guard = createReadGuard("test-session");
		guard.recordRead(rec("C:/Proj/Src/Api.ts"));

		expect(guard.checkEdit("c:/proj/src/api.ts").action).toBe("allow");
	});

	it("still blocks a genuinely unread file (guard not weakened)", () => {
		const guard = createReadGuard("test-session");

		const verdict = guard.checkEdit("/proj/never-read.ts");

		expect(verdict.action).toBe("block");
		expect(verdict.reason).toContain("Edit without read");
	});
});
