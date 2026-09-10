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
import { removeTempDirSync } from "./test-utils.js";

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

// Deterministic cooperativeness guard (closes #2886, sibling of #2254). The
// previous revision measured the parse through measureMaxSyncBlockMs and
// asserted maxBlock < 75ms: a wall-clock occupancy bound whose sampler gap
// grows whenever the OS deschedules the worker, so it redded under CI lane
// contention (75.83ms and 83.08ms against the 75ms budget on an unrelated
// diff) while the parser was unchanged. This revision counts the parser's own
// event-loop yields instead: readPhaseLogTail awaits one setImmediate every
// PARSE_YIELD_EVERY iterated lines, so the yield count is floor(fedLines /
// PARSE_YIELD_EVERY) — a function of the input alone, invariant to worker
// contention. Neutering the yield collapses the count to zero; yielding per
// line inflates it to fedLines; either reds the exact equality below.
// Measured on the default 10MB window: 82639 fed lines, 165 yields. The
// >100 floor below only guards fixture shrinkage, not the parser.
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
