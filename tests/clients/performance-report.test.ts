import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";
import {
	collectLatencyPerformance,
	renderLatencyPerformanceReport,
	resolveLogByteBudget,
	summarizePhaseLatency,
} from "../../clients/performance-report.js";
import { removeTempDirSync } from "./test-utils.js";

function phase(
	name: string,
	durationMs: number,
	overrides: Partial<LatencyEntry> = {},
): LatencyEntry {
	return {
		type: "phase",
		filePath: "<pi-lens>",
		phase: name,
		durationMs,
		...overrides,
	};
}

function writeEntries(
	filePath: string,
	entries: readonly LatencyEntry[],
): void {
	fs.writeFileSync(
		filePath,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
}

describe("performance-report", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-perf-report-"));
	});

	afterEach(() => {
		removeTempDirSync(tempDir);
	});

	it("groups valid phase timings and ranks p50 and p99 independently", () => {
		const entries: LatencyEntry[] = [
			phase("steady", 80, { ts: "2026-01-01T00:00:00.000Z" }),
			phase("steady", 80, { ts: "2026-01-01T00:00:01.000Z" }),
			phase("steady", 80, { ts: "2026-01-01T00:00:02.000Z" }),
			phase("spiky", 1),
			phase("spiky", 1),
			phase("spiky", 200, { ts: "2026-01-01T00:00:03.000Z" }),
			{ type: "runner", filePath: "x.ts", durationMs: 500, runnerId: "lsp" },
			phase("marker", 0),
			phase("invalid", -1),
		];

		const result = summarizePhaseLatency(entries, 2);

		expect(result.sampleCount).toBe(6);
		expect(result.phaseCount).toBe(2);
		expect(result.oldestTs).toBe("2026-01-01T00:00:00.000Z");
		expect(result.newestTs).toBe("2026-01-01T00:00:03.000Z");
		expect(result.slowestByP50.map((entry) => entry.phase)).toEqual([
			"steady",
			"spiky",
		]);
		expect(result.slowestByP99.map((entry) => entry.phase)).toEqual([
			"spiky",
			"steady",
		]);
		expect(result.slowestByP99[0]).toEqual({
			phase: "spiky",
			samples: 3,
			p50Ms: 1,
			p99Ms: 196,
		});
	});

	it("never ranks an age: a new-format ageMs row and a pre-#5379 legacy line are both excluded (#5379)", async () => {
		// Recurrence: `lsp_document_drift` p99 2,220,473 ms topped slowestByP99 on a
		// live log. A line written before the field existed holds the age in
		// `durationMs` and is told apart by the shared legacy list alone.
		const logPath = path.join(tempDir, "latency.log");
		const lines = [
			phase("real_work", 120),
			{ type: "phase", phase: "lsp_document_drift", filePath: "x", ageMs: 9e6 },
			phase("lsp_document_drift", 2_220_473), // legacy line
			{ type: "phase", phase: "host_boot", filePath: "x", durationMs: 52_400 },
			phase("fresh_age_producer", 1_000_000, { ageMs: 1_000_000 }),
		];
		writeEntries(logPath, lines as LatencyEntry[]);

		const report = await collectLatencyPerformance({
			logPath,
			sessionStartedAt: 0,
			topN: 10,
		});

		expect(report.logWindow.slowestByP99.map((row) => row.phase)).toEqual([
			"real_work",
		]);
		expect(report.logWindow.sampleCount).toBe(1);
		// An age row is a valid record, not a malformed one.
		expect(report.invalidRecords).toBe(0);
	});

	it("honors a topN above the default and falls back to it when invalid", () => {
		const entries = Array.from({ length: 12 }, (_, index) =>
			phase(`p${index}`, index + 1),
		);

		expect(summarizePhaseLatency(entries, 8).slowestByP99).toHaveLength(8);
		expect(summarizePhaseLatency(entries, 0).slowestByP99).toHaveLength(5);
		expect(
			summarizePhaseLatency(entries, Number.NaN).slowestByP99,
		).toHaveLength(5);
	});

	it("separates generic phase names by tool", () => {
		const result = summarizePhaseLatency([
			phase("total", 10, { toolName: "write" }),
			phase("total", 20, { toolName: "edit" }),
		]);

		expect(result.slowestByP99.map((entry) => entry.phase)).toEqual([
			"edit/total",
			"write/total",
		]);
	});

	it("skips malformed NDJSON lines without losing valid neighbors", async () => {
		const logPath = path.join(tempDir, "latency.log");
		fs.writeFileSync(
			logPath,
			'{"type":"phase","phase":"a","filePath":"x","durationMs":10}\n' +
				'{"type":"phase"\n' +
				"null\n" +
				'{"type":"phase","phase":"bad-tool","filePath":"x","durationMs":30,"toolName":7}\n' +
				'{"type":"phase","phase":"b","filePath":"x","durationMs":20}\n',
		);

		const report = await collectLatencyPerformance({
			logPath,
			processId: 7,
			sessionStartedAt: 0,
		});

		expect(report.logWindow.sampleCount).toBe(2);
		expect(report.malformedLines).toBe(1);
		expect(report.invalidRecords).toBe(2);
	});

	it("isolates the current process and session while retaining the whole log window", async () => {
		const logPath = path.join(tempDir, "latency.log");
		const lines = [
			phase("work", 10, {
				pid: 11,
				ts: "2026-01-01T00:00:01.000Z",
			}),
			phase("work", 30, {
				pid: 11,
				ts: "2026-01-01T00:00:02.000Z",
			}),
			phase("foreign", 900, {
				pid: 12,
				ts: "2026-01-01T00:00:02.000Z",
			}),
			phase("old", 800, {
				pid: 11,
				ts: "2025-12-31T23:59:59.000Z",
			}),
			phase("straddled", 700, {
				pid: 11,
				startedAt: "2025-12-31T23:59:59.900Z",
				ts: "2026-01-01T00:00:00.100Z",
			}),
		];
		writeEntries(logPath, lines);

		const report = await collectLatencyPerformance({
			logPath,
			processId: 11,
			sessionStartedAt: Date.parse("2026-01-01T00:00:00.000Z"),
		});

		expect(report.session.sampleCount).toBe(2);
		expect(report.session.slowestByP99).toEqual([
			{ phase: "work", samples: 2, p50Ms: 20, p99Ms: 29.8 },
		]);
		expect(report.logWindow.sampleCount).toBe(5);
		expect(report.logWindow.slowestByP99[0].phase).toBe("foreign");
	});

	it("reads a bounded tail and reports truncation", async () => {
		const logPath = path.join(tempDir, "latency.log");
		const lastEntry = JSON.stringify(
			phase("kept", 25, {
				pid: 7,
				ts: "2026-01-01T00:00:01.000Z",
			}),
		);
		fs.writeFileSync(logPath, `${"x".repeat(200)}\n${lastEntry}\n`);

		const report = await collectLatencyPerformance({
			logPath,
			maxBytes: Buffer.byteLength(lastEntry) + 20,
			processId: 7,
			sessionStartedAt: Date.parse("2026-01-01T00:00:00.000Z"),
		});

		expect(report.windowTruncated).toBe(true);
		expect(report.logWindow.sampleCount).toBe(1);
		expect(report.logWindow.slowestByP99[0].phase).toBe("kept");
	});

	it("bounds the window by the log rotation threshold", async () => {
		const logPath = path.join(tempDir, "latency.log");
		const line = `${JSON.stringify(phase("bulk", 5))}\n`;
		fs.writeFileSync(
			logPath,
			line.repeat(Math.ceil((1.5 * 1024 * 1024) / Buffer.byteLength(line))),
		);
		const previous = process.env.PI_LENS_MAX_LOG_SIZE_MB;
		process.env.PI_LENS_MAX_LOG_SIZE_MB = "1";
		try {
			const report = await collectLatencyPerformance({
				logPath,
				processId: 7,
				sessionStartedAt: 0,
			});

			expect(report.windowBytes).toBe(1024 * 1024);
			expect(report.windowTruncated).toBe(true);
			expect(renderLatencyPerformanceReport(report)).toContain(
				"newest 1MB of the active log",
			);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_MAX_LOG_SIZE_MB;
			else process.env.PI_LENS_MAX_LOG_SIZE_MB = previous;
		}
	});

	it("reports the byte window actually used, not the default cap", async () => {
		const logPath = path.join(tempDir, "latency.log");
		const entry = JSON.stringify(phase("kept", 25));
		fs.writeFileSync(logPath, `${"x".repeat(4096)}\n${entry}\n`);

		const report = await collectLatencyPerformance({
			logPath,
			maxBytes: 2048,
			processId: 7,
			sessionStartedAt: 0,
		});

		expect(report.windowBytes).toBe(2048);
		const output = renderLatencyPerformanceReport(report);
		expect(output).toContain("newest 2KB of the active log");
		expect(output).not.toContain("10MB");
	});

	it("keeps a complete line when the byte cap starts at its boundary", async () => {
		const logPath = path.join(tempDir, "latency.log");
		const first = JSON.stringify(phase("first", 10));
		const second = JSON.stringify(phase("second", 20));
		fs.writeFileSync(logPath, `${first}\n${second}\n`);

		const report = await collectLatencyPerformance({
			logPath,
			maxBytes: Buffer.byteLength(`${second}\n`),
			processId: 7,
			sessionStartedAt: 0,
		});

		expect(report.windowTruncated).toBe(true);
		expect(report.logWindow.sampleCount).toBe(1);
		expect(report.logWindow.slowestByP99[0].phase).toBe("second");
	});

	it("keeps the newest phase samples when the entry cap is reached", async () => {
		const logPath = path.join(tempDir, "latency.log");
		const lines = [phase("first", 10), phase("second", 20), phase("third", 30)];
		writeEntries(logPath, lines);

		const report = await collectLatencyPerformance({
			logPath,
			maxSamples: 2,
			processId: 7,
			sessionStartedAt: 0,
		});

		expect(report.logSamplesTruncated).toBe(true);
		expect(report.totalPhaseSamples).toBe(3);
		expect(report.logWindow.sampleCount).toBe(2);
		expect(report.logWindow.slowestByP99.map((entry) => entry.phase)).toEqual([
			"third",
			"second",
		]);
	});

	it("caps machine-wide and current-session samples independently", async () => {
		const logPath = path.join(tempDir, "latency.log");
		const lines = [
			phase("current", 10, {
				pid: 7,
				ts: "2026-01-01T00:00:01.000Z",
			}),
			phase("foreign-1", 20, { pid: 8, ts: "2026-01-01T00:00:02.000Z" }),
			phase("foreign-2", 30, { pid: 8, ts: "2026-01-01T00:00:03.000Z" }),
			phase("foreign-3", 40, { pid: 8, ts: "2026-01-01T00:00:04.000Z" }),
		];
		writeEntries(logPath, lines);

		const report = await collectLatencyPerformance({
			logPath,
			maxSamples: 2,
			processId: 7,
			sessionStartedAt: Date.parse("2026-01-01T00:00:00.000Z"),
		});

		expect(report.logSamplesTruncated).toBe(true);
		expect(report.logWindow.sampleCount).toBe(2);
		expect(report.sessionSamplesTruncated).toBe(false);
		expect(report.session.sampleCount).toBe(1);
		expect(report.session.slowestByP99[0].phase).toBe("current");
	});

	it("surfaces unreadable log paths instead of reporting an empty window", async () => {
		await expect(
			collectLatencyPerformance({
				logPath: tempDir,
				processId: 7,
				sessionStartedAt: 0,
			}),
		).rejects.toThrow();
	});

	it("renders both scopes and data-quality notices", () => {
		const output = renderLatencyPerformanceReport({
			logPath: "/tmp/latency.log",
			topN: 3,
			windowBytes: resolveLogByteBudget(),
			windowTruncated: true,
			logSamplesTruncated: true,
			sessionSamplesTruncated: true,
			totalPhaseSamples: 30_000,
			totalSessionPhaseSamples: 25_000,
			malformedLines: 2,
			invalidRecords: 1,
			session: summarizePhaseLatency([phase("session-work", 120)], 3),
			logWindow: summarizePhaseLatency([phase("window-work", 1500)], 3),
		});

		expect(output).toContain("Top 3 sustained and tail latency phases");
		expect(output).toContain("Highest p50:");
		expect(output).toContain("Highest p99:");
		expect(output).toContain("session-work: p50 120ms, p99 120ms, n=1");
		expect(output).toContain("window-work: p50 1.50s, p99 1.50s, n=1");
		expect(output).toContain("Both scopes use only the newest 10MB");
		expect(output).toContain("newest 1 of 25,000 phase samples");
		expect(output).toContain("newest 1 of 30,000 phase samples");
		expect(output).toContain(
			"Skipped 2 malformed line(s) and 1 invalid record(s)",
		);
	});
});
