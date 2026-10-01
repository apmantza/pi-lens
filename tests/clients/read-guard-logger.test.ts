/**
 * #1913: `read_cap_trimmed` must survive `read-guard-logger`'s verbosity
 * gate at DEFAULT verbosity (PI_LENS_READ_GUARD_VERBOSE unset), while the
 * per-read `read_recorded` event stays gated as before.
 */
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	sanitizeCorrelationId,
	shouldLogEvent,
} from "../../clients/read-guard-logger.js";

describe("shouldLogEvent", () => {
	it("always logs read_cap_trimmed, even at default verbosity", () => {
		expect(shouldLogEvent("read_cap_trimmed")).toBe(true);
	});

	// #1918: read_cap_trimmed's population siblings. read-guard.test.ts mocks
	// read-guard-logger.js wholesale, so it can't see this gate at all — this
	// file is the only place a dropped always-on arm reds.
	it("always logs read_file_evicted, even at default verbosity", () => {
		expect(shouldLogEvent("read_file_evicted")).toBe(true);
	});

	it("always logs edits_cap_trimmed, even at default verbosity", () => {
		expect(shouldLogEvent("edits_cap_trimmed")).toBe(true);
	});

	it("keeps read_recorded gated behind verbose mode", () => {
		expect(shouldLogEvent("read_recorded")).toBe(false);
	});

	it("still logs the pre-existing always-on events", () => {
		expect(shouldLogEvent("edit_blocked")).toBe(true);
	});

	it("writes partial-apply outcomes to the real sink at default verbosity", async () => {
		const previous = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		vi.resetModules();
		try {
			const logger = await import("../../clients/read-guard-logger.js");
			for (const event of [
				"edit_partial_apply_rejected",
				"edit_already_applied_retry",
				"edit_post_edit_pipeline_failed",
			]) {
				logger.logReadGuardEvent({
					event,
					filePath: "C:\\workspace\\sample.ts",
					metadata: { editIndex: 2 },
				});
			}
			await logger.flushReadGuardLog();
			const lines = fs
				.readFileSync(logger.getReadGuardLogPath(), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event: string });
			expect(lines.map((line) => line.event)).toEqual(
				expect.arrayContaining([
					"edit_partial_apply_rejected",
					"edit_already_applied_retry",
					"edit_post_edit_pipeline_failed",
				]),
			);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previous;
			vi.resetModules();
		}
	});
});

/**
 * #2219 (the #2141 class): `logReadGuardEvent`'s `filePath` reaches it from
 * `runtime-tool-result.ts`'s raw `path.resolve()`/`path.isAbsolute()`
 * arithmetic, never `normalizeFilePath`-passed. Mirrors
 * `review-graph-logger.test.ts`'s mock-the-writer pattern.
 */
describe("logReadGuardEvent filePath normalization (#2219)", () => {
	it("normalizes a backslash-supplied filePath to the canonical slash form", async () => {
		vi.resetModules();
		const writerLog = vi.fn();
		vi.doMock("../../clients/env-utils.js", () => ({
			isTestMode: () => false,
		}));
		vi.doMock("../../clients/ndjson-logger.js", () => ({
			createNdjsonLogger: () => ({
				log: writerLog,
				append: vi.fn(),
				truncate: vi.fn(),
				flush: vi.fn().mockResolvedValue(undefined),
				flushSync: vi.fn(),
			}),
		}));

		const mod = await import("../../clients/read-guard-logger.js");
		const { normalizeFilePath } = await import("../../clients/path-utils.js");

		mod.logReadGuardEvent({
			event: "edit_blocked",
			filePath: "C:\\Users\\dev\\pi-free\\src\\a.ts",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0].filePath).toBe(
			normalizeFilePath("C:\\Users\\dev\\pi-free\\src\\a.ts"),
		);

		vi.doUnmock("../../clients/env-utils.js");
		vi.doUnmock("../../clients/ndjson-logger.js");
		vi.resetModules();
	});
});

/**
 * #3833: every map keyed by a tool-call id (attribution, read widening, the
 * read-guard branch filter) trusts `sanitizeCorrelationId` to be injective.
 * The recurrence: a plain 64-char slice merged pi 0.99 codemode's nested
 * `<openai-parent-id>/<n>` ids into one key, so parallel nested edits shared
 * one attribution and turn_end reported a false `clean`.
 */
describe("sanitizeCorrelationId (#3833)", () => {
	const parent = `call_${"x".repeat(40)}|fc_${"y".repeat(45)}`;

	it("keeps ids of 64 characters or fewer exactly as before", () => {
		expect(sanitizeCorrelationId("call_a")).toBe("call_a");
		expect(sanitizeCorrelationId("  call_b|fc_1 ")).toBe("call_b_fc_1");
		expect(sanitizeCorrelationId(42)).toBe("42");
		const exactly64 = "a".repeat(64);
		expect(sanitizeCorrelationId(exactly64)).toBe(exactly64);
		expect(sanitizeCorrelationId("   ")).toBeUndefined();
		expect(sanitizeCorrelationId({})).toBeUndefined();
	});

	it("bounds a long id to 64 characters of the allowed alphabet, readable prefix first", () => {
		const out = sanitizeCorrelationId(`${parent}/1`) as string;
		expect(out.length).toBe(64);
		expect(out).toMatch(/^[a-zA-Z0-9._:-]+$/);
		expect(out.startsWith("call_xxxxxxxx")).toBe(true);
	});

	it("never merges ids that differ anywhere, including past char 64 and at the last char", () => {
		const raw = [
			`${parent}/1`,
			`${parent}/2`,
			`${parent}/10`,
			`${parent}/1/1`,
			`${parent}z/1`,
			`${"q".repeat(63)}a${"q".repeat(40)}`,
			`${"q".repeat(63)}b${"q".repeat(40)}`,
			`${"q".repeat(105)}a`,
			`${"q".repeat(105)}b`,
		];
		const keys = raw.map((id) => sanitizeCorrelationId(id));
		expect(new Set(keys).size).toBe(raw.length);
	});

	it("is deterministic and idempotent, so a stored id re-sanitizes to itself", () => {
		const once = sanitizeCorrelationId(`${parent}/7`) as string;
		expect(sanitizeCorrelationId(`${parent}/7`)).toBe(once);
		expect(sanitizeCorrelationId(once)).toBe(once);
	});
});
