// flake-shape: elapsed-time-assertion — event-loop occupancy has no deterministic proxy; the yield count below is O(input) and cannot see per-chunk block growth, so this file keeps one real-clock occupancy row in the serialized wall-clock-budget lane (#2886 round 2)
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	collectLatencyPerformance,
	MAX_PERF_PHASE_SAMPLES,
	PARSE_YIELD_EVERY,
	resolveLogByteBudget,
} from "../../clients/performance-report.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";
import { removeTempDirSync } from "./test-utils.js";

// Occupancy ceiling for the full-window /lens-perf parse, measured through
// the sampler rather than a wall clock around the parse: the sampler gap is
// the longest synchronous stretch the parser held the loop. Calibrated from
// the serialized wall-clock-budget lane's own runs (see the round-2 note in
// the PR body): quiet runs read well under half of this, while the reviewer's
// deliberate O(n^2) parser regressions measured 222-712ms against it.
const MAX_SYNC_BLOCK_MS = 75;

// Coarse whole-parse wall budget. This is the backstop only: the sampler row
// above is the occupancy property, and the yield-count test below is the
// cadence property. An O(n^2) regression blows both this and the sampler row;
// lane-quiet parses finish two orders of magnitude under it, so it cannot
// flake where it runs.
const MAX_PARSE_WALL_MS = 10_000;

// Size the fixture to the window production actually reads, so the parse this
// measures can't silently shrink if the rotation threshold or its default moves.
const WINDOW_BYTES = resolveLogByteBudget();

let tempDir: string;
let logPath: string;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-perf-occupancy-"));
	logPath = path.join(tempDir, "latency.log");
	const chunk = Array.from(
		{ length: 1000 },
		(_, index) =>
			`${JSON.stringify({
				type: "phase",
				phase: "occupancy-fixture",
				filePath: "fixture.ts",
				durationMs: ((index * 7919) % 10_000) + 1,
				pid: 7,
				ts: "2026-01-01T00:00:00.000Z",
			})}\n`,
	).join("");
	fs.writeFileSync(
		logPath,
		chunk.repeat(Math.ceil(WINDOW_BYTES / Buffer.byteLength(chunk))),
	);
}, 30_000);

afterAll(() => {
	removeTempDirSync(tempDir);
});

// Occupancy guard (re-admitted #2886 round 2, refs #2886). The deterministic
// yield-count test below guards CADENCE — floor(fedLines / PARSE_YIELD_EVERY)
// is a function of the input alone, so a parser regression that keeps the
// cadence while growing per-chunk work (a 200ms busy block per chunk, or a
// genuine quadratic) stays green there and must red here instead. Proof of
// the split is quoted in the PR body: both reviewer probes red this row while
// the cadence row stays green.
it(
	"keeps /lens-perf log parsing below the event-loop occupancy budget",
	{
		timeout: 30_000,
	},
	async () => {
		const startedAt = Date.now();
		let retainedSamples = 0;
		const maxBlock = await measureMaxSyncBlockMs(async () => {
			const report = await collectLatencyPerformance({
				logPath,
				processId: 7,
				sessionStartedAt: 0,
			});
			retainedSamples = report.logWindow.sampleCount;
			// Fail loudly if the fixture no longer fills the window — otherwise this
			// keeps passing while measuring a parse it was never meant to.
			expect(report.windowBytes).toBe(WINDOW_BYTES);
			expect(report.windowTruncated).toBe(true);
		});
		const elapsedMs = Date.now() - startedAt;

		expect(retainedSamples).toBe(MAX_PERF_PHASE_SAMPLES);
		expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		expect(elapsedMs).toBeLessThan(MAX_PARSE_WALL_MS);
	},
);

// Deterministic cooperativeness guard (closes #2886 cadence half). The
// previous revision measured the parse ONLY through measureMaxSyncBlockMs and
// asserted maxBlock < 75ms: a wall-clock occupancy bound whose sampler gap
// grows whenever the OS deschedules the worker, so it redded under CI lane
// contention (75.83ms and 83.08ms against the 75ms budget on an unrelated
// diff) while the parser was unchanged. This test counts the parser's own
// event-loop yields instead: readPhaseLogTail awaits one setImmediate every
// PARSE_YIELD_EVERY iterated lines, so the yield count is floor(fedLines /
// PARSE_YIELD_EVERY) — a function of the input alone, invariant to worker
// contention. Neutering the yield collapses the count to zero; yielding per
// line inflates it to fedLines; either reds the exact equality below.
// Measured on the default 10MB window: 82639 fed lines, 165 yields. The
// >100 floor below only guards fixture shrinkage, not the parser.
//
// What this test does NOT guard (stated, not orphaned): per-chunk block
// size. That property belongs to the occupancy row above, re-admitted in the
// serialized wall-clock-budget lane — unlike #2254's clock-read count, which
// varies with the algorithm, this count varies only with the input.
it(
	"parses the full log window while yielding the event loop on cadence",
	{
		timeout: 30_000,
	},
	async () => {
		// Lines the parser actually iterates: the trailing windowBytes of the
		// file. Counted from the input bytes, not from the parser's loop, so
		// the expectation cannot mirror the implementation it guards.
		const { size } = fs.statSync(logPath);
		const start = Math.max(0, size - WINDOW_BYTES);
		const tail = fs.readFileSync(logPath).subarray(start);
		let fedLines = 0;
		for (const byte of tail) {
			if (byte === 0x0a) fedLines += 1;
		}
		const expectedYields = Math.floor(fedLines / PARSE_YIELD_EVERY);
		expect(expectedYields).toBeGreaterThan(100);

		const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
		let retainedSamples = 0;
		let yieldCount = 0;
		try {
			const report = await collectLatencyPerformance({
				logPath,
				processId: 7,
				sessionStartedAt: 0,
			});
			retainedSamples = report.logWindow.sampleCount;
			// Fail loudly if the fixture no longer fills the window — otherwise this
			// keeps passing while measuring a parse it was never meant to.
			expect(report.windowBytes).toBe(WINDOW_BYTES);
			expect(report.windowTruncated).toBe(true);
		} finally {
			// Read the count BEFORE restoring: mockRestore clears mock history.
			yieldCount = setImmediateSpy.mock.calls.length;
			setImmediateSpy.mockRestore();
		}

		expect(retainedSamples).toBe(MAX_PERF_PHASE_SAMPLES);
		expect(yieldCount).toBe(expectedYields);
	},
);
