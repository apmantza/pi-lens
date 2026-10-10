/**
 * #4124: the serialized word-index memo is also what makes a persist
 * incremental (#2068, #2202). It is kept across a run's persists, released at
 * `agent_settled`, and bounded by a stalled-run backstop. Fake timers drive the
 * backstop; the settle itself is exercised through `index.ts` in
 * `tests/index-word-index-memo-settle.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRecentLoggedPhases } from "../../clients/latency-logger.js";
import {
	buildWordIndex,
	deserializeWordIndex,
	getLastWordIndexSerializeWork,
	releaseWordIndexMemoAtSettle,
	searchWordIndex,
	serializeWordIndex,
	updateWordIndexDocument,
} from "../../clients/word-index.js";

describe("word-index serialized memo lifecycle (#4124)", () => {
	const threeFiles = [
		{ path: "src/a.ts", content: "function alphaHandler() {}" },
		{ path: "src/b.ts", content: "function betaHandler(alpha) {}" },
		{ path: "src/c.ts", content: "function gammaHandler() {}" },
	];

	/**
	 * Whether the NEXT persist of an unchanged index is served from the memo.
	 * Destructive on purpose: serializing re-creates (and re-arms) the memo, so
	 * this is the last observation of a case.
	 */
	function memoServesNextSerialize(index: ReturnType<typeof buildWordIndex>) {
		serializeWordIndex(index);
		return getLastWordIndexSerializeWork()?.tookFullPath === false;
	}

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("keeps the memo across a run's persists and drops it at settle, leaving the decoded index live", () => {
		const index = buildWordIndex(threeFiles);
		serializeWordIndex(index);
		updateWordIndexDocument(index, {
			path: "src/a.ts",
			content: "function alphaHandler() { changedMarker(); }",
		});
		// Recurrence: #4124's first round released the memo after every
		// publication, so each later edit's persist was a full re-serialize
		// (affectedTokenCount 59,182 on this repo) instead of O(dirty tokens).
		serializeWordIndex(index);
		expect(getLastWordIndexSerializeWork()).toMatchObject({
			tookFullPath: false,
		});
		expect(getLastWordIndexSerializeWork()?.affectedTokenCount).toBeLessThan(
			10,
		);

		releaseWordIndexMemoAtSettle(index);

		expect(memoServesNextSerialize(index)).toBe(false);
		expect(searchWordIndex(index, "alpha handler").map((r) => r.file)).toEqual(
			expect.arrayContaining(["src/a.ts", "src/b.ts"]),
		);
	});

	it("logs one row when a held memo is released and none when nothing is held", () => {
		const index = buildWordIndex(threeFiles);
		const rows = () =>
			getRecentLoggedPhases().filter(
				(entry) => entry.phase === "word_index_memo_released",
			);
		const before = rows().length;
		releaseWordIndexMemoAtSettle(index);
		expect(rows()).toHaveLength(before);

		serializeWordIndex(index);
		releaseWordIndexMemoAtSettle(index);
		releaseWordIndexMemoAtSettle(index);
		expect(rows()).toHaveLength(before + 1);
		expect(rows()[0].metadata).toEqual({ trigger: "settle", files: 3 });
	});

	it("releases a stalled run's memo after the 10 minute default backstop", () => {
		vi.useFakeTimers();
		const held = buildWordIndex(threeFiles);
		serializeWordIndex(held);
		vi.advanceTimersByTime(10 * 60_000 - 1);
		expect(memoServesNextSerialize(held)).toBe(true);

		const stalled = buildWordIndex(threeFiles);
		serializeWordIndex(stalled);
		vi.advanceTimersByTime(10 * 60_000);
		expect(memoServesNextSerialize(stalled)).toBe(false);
		expect(
			getRecentLoggedPhases().find(
				(entry) => entry.phase === "word_index_memo_released",
			)?.metadata,
		).toEqual({ trigger: "backstop", files: 3 });
	});

	it("honors PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS and re-arms it on every serialize", () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS", "1000");
		const index = buildWordIndex(threeFiles);
		serializeWordIndex(index);
		vi.advanceTimersByTime(800);
		serializeWordIndex(index);
		// 1,600 ms after the first serialize but 800 ms after the re-arm.
		vi.advanceTimersByTime(800);
		expect(memoServesNextSerialize(index)).toBe(true);

		const idle = buildWordIndex(threeFiles);
		serializeWordIndex(idle);
		vi.advanceTimersByTime(1000);
		expect(memoServesNextSerialize(idle)).toBe(false);
	});

	it("also bounds the memo seeded by a snapshot load, which no serialize armed", () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS", "1000");
		// Recurrence: a session that loads the persisted index and never edits
		// held the loaded wire form for its whole life.
		const loaded = deserializeWordIndex(
			serializeWordIndex(buildWordIndex(threeFiles)),
		)!;
		vi.advanceTimersByTime(1000);
		expect(memoServesNextSerialize(loaded)).toBe(false);
	});

	it("arms the backstop unref'd, so a process that serializes and ends is not held open", () => {
		// Recurrence: a ref'd 10 minute timer made a one-shot node process (an MCP
		// call, a script) exit only after the whole delay.
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			const index = buildWordIndex(threeFiles);
			serializeWordIndex(index);
			const timer = setTimeoutSpy.mock.results.at(-1)?.value as
				| { hasRef(): boolean }
				| undefined;
			expect(timer?.hasRef()).toBe(false);
			releaseWordIndexMemoAtSettle(index);
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	describe("PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS range", () => {
		const MAX_TIMER_DELAY_MS = 2_147_483_647;

		// Recurrence: Node clamps a delay above 2^31-1 ms to 1 ms (and warns), so
		// a huge value released the memo at once on every serialize.
		it.each(["99999999999", "2147483648"])(
			"clamps %s ms to the largest timer delay instead of firing at once",
			(value) => {
				vi.useFakeTimers();
				vi.stubEnv("PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS", value);
				const early = buildWordIndex(threeFiles);
				serializeWordIndex(early);
				vi.advanceTimersByTime(MAX_TIMER_DELAY_MS - 1);
				expect(memoServesNextSerialize(early)).toBe(true);

				const clamped = buildWordIndex(threeFiles);
				serializeWordIndex(clamped);
				vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
				expect(memoServesNextSerialize(clamped)).toBe(false);
			},
		);

		// Recurrence: 0 was accepted as a 0 ms backstop, which is the memo
		// switched off. It now means the default, as does a value that is not a
		// positive number.
		it.each(["0", "-5", "soon"])(
			"treats %s as the 10 minute default",
			(value) => {
				vi.useFakeTimers();
				vi.stubEnv("PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS", value);
				const held = buildWordIndex(threeFiles);
				serializeWordIndex(held);
				vi.advanceTimersByTime(10 * 60_000 - 1);
				expect(memoServesNextSerialize(held)).toBe(true);

				const released = buildWordIndex(threeFiles);
				serializeWordIndex(released);
				vi.advanceTimersByTime(10 * 60_000);
				expect(memoServesNextSerialize(released)).toBe(false);
			},
		);
	});
});
