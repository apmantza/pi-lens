import { beforeEach, describe, expect, it, vi } from "vitest";
import { logExtension } from "../../clients/extension-log.js";
const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/extension-log.js", () => ({ logExtension: vi.fn() }));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));
import {
	DEGRADATION_ENTRIES_PER_KIND,
	DEGRADATION_MAX_DISTINCT_KINDS,
	getDegradationLedgerGeneration,
	getDegradationSummary,
	incrementDegradationCount,
	recordDegradation,
	recordDegradationOnce,
	renderDegradationLines,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

beforeEach(() => {
	resetDegradationLedger();
	vi.mocked(logExtension).mockClear();
	logLatency.mockClear();
});

describe("session degradation ledger", () => {
	it("groups kinds and returns detached latest reasons", () => {
		recordDegradation({
			kind: "spawn-failure",
			subject: "a",
			reason: "denied",
		});
		recordDegradation({
			kind: "trust-refusal",
			subject: "b",
			reason: "untrusted",
		});
		recordDegradation({
			kind: "spawn-failure",
			subject: "c",
			reason: "bad cwd",
		});
		const summary = getDegradationSummary();
		expect(summary.map(({ kind, count }) => ({ kind, count }))).toEqual([
			{ kind: "spawn-failure", count: 2 },
			{ kind: "trust-refusal", count: 1 },
		]);
		expect(summary[0].latestReasons.at(-1)).toEqual({
			subject: "c",
			reason: "bad cwd",
		});
		summary[0].latestReasons[0].reason = "mutated";
		expect(getDegradationSummary()[0].latestReasons[0].reason).toBe("denied");
	});

	it("bounds retained entries per kind while counting beyond the cap", () => {
		for (let i = 0; i < DEGRADATION_ENTRIES_PER_KIND + 7; i++) {
			recordDegradation({
				kind: "formatter-skip",
				subject: `f${i}`,
				reason: `r${i}`,
			});
		}
		const [group] = getDegradationSummary();
		expect(group.count).toBe(DEGRADATION_ENTRIES_PER_KIND + 7);
		expect(group.droppedCount).toBe(7);
		expect(group.latestReasons).toHaveLength(DEGRADATION_ENTRIES_PER_KIND);
		expect(group.latestReasons[0].subject).toBe("f7");
	});

	it("dedupes once-records and tallies repeated events into one subject entry", () => {
		const formatter = {
			kind: "formatter-failure" as const,
			subject: "prettier:a.ts",
			reason: "timed out",
		};
		recordDegradationOnce(formatter);
		recordDegradationOnce(formatter);
		for (let i = 0; i < 3; i++)
			incrementDegradationCount({
				kind: "lsp-diagnostics-timeout",
				subject: "typescript",
				reason: "diagnostics wait timed out",
			});
		const [failure, timeouts] = getDegradationSummary();
		expect(failure.count).toBe(1);
		expect(timeouts.count).toBe(3);
		expect(timeouts.latestReasons).toEqual([
			{
				subject: "typescript",
				reason: "diagnostics wait timed out (count: 3)",
			},
		]);
	});

	it("writes one durable row for one once-record", () => {
		recordDegradationOnce({
			kind: "formatter-failure",
			subject: "prettier:a.ts",
			reason: "timed out",
		});

		expect(logLatency).toHaveBeenCalledOnce();
		expect(logLatency).toHaveBeenCalledWith({
			type: "phase",
			phase: "degradation_ledger",
			filePath: "prettier:a.ts",
			durationMs: 0,
			metadata: {
				kind: "formatter-failure",
				subject: "prettier:a.ts",
				count: 1,
				ledgerGeneration: getDegradationLedgerGeneration(),
			},
		});
	});

	it("carries record metadata on durable ledger rows", () => {
		incrementDegradationCount({
			kind: "cache-usage-attribution-stale",
			subject: "message_end",
			reason: "missing session id",
			metadata: { sessionId: "session-one" },
		});

		expect(logLatency).toHaveBeenCalledWith({
			type: "phase",
			phase: "degradation_ledger",
			filePath: "message_end",
			durationMs: 0,
			metadata: {
				sessionId: "session-one",
				kind: "cache-usage-attribution-stale",
				subject: "message_end",
				count: 1,
				ledgerGeneration: getDegradationLedgerGeneration(),
			},
		});
	});

	it("bounds metadata values and key count on durable ledger rows", () => {
		incrementDegradationCount({
			kind: "cache-usage-attribution-stale",
			subject: "message_end",
			reason: "missing session id",
			metadata: Object.fromEntries(
				Array.from({ length: 10 }, (_, index) => [
					`field${index}`,
					index === 0 ? "x".repeat(500) : `value-${index}`,
				]),
			),
		});

		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					field0: `${"x".repeat(200)}…`,
					metadataDropped: 2,
				}),
			}),
		);
	});

	it("writes updated counts without duplicating once-records", () => {
		const once = {
			kind: "formatter-failure" as const,
			subject: "prettier:a.ts",
			reason: "timed out",
		};
		recordDegradationOnce(once);
		recordDegradationOnce(once);
		incrementDegradationCount({
			kind: "lsp-diagnostics-timeout",
			subject: "typescript",
			reason: "diagnostics wait timed out",
		});
		incrementDegradationCount({
			kind: "lsp-diagnostics-timeout",
			subject: "typescript",
			reason: "diagnostics wait timed out",
		});

		expect(logLatency).toHaveBeenCalledTimes(3);
		expect(logLatency.mock.calls.map(([row]) => row.metadata)).toEqual([
			{
				kind: "formatter-failure",
				subject: "prettier:a.ts",
				count: 1,
				ledgerGeneration: getDegradationLedgerGeneration(),
			},
			{
				kind: "lsp-diagnostics-timeout",
				subject: "typescript",
				count: 1,
				ledgerGeneration: getDegradationLedgerGeneration(),
			},
			{
				kind: "lsp-diagnostics-timeout",
				subject: "typescript",
				count: 2,
				ledgerGeneration: getDegradationLedgerGeneration(),
			},
		]);
	});

	it("bounds durable rows for repeated and distinct subjects", () => {
		for (let i = 0; i < 100; i++) {
			incrementDegradationCount({
				kind: "formatter-failure",
				subject: "same",
				reason: "timed out",
			});
		}
		expect(logLatency).toHaveBeenCalledTimes(7);
		expect(logLatency.mock.calls.map(([row]) => row.metadata.count)).toEqual([
			1, 2, 4, 8, 16, 32, 64,
		]);

		resetDegradationLedger();
		for (let i = 0; i < 100; i++) {
			recordDegradationOnce({
				kind: "formatter-failure",
				subject: `subject-${i}`,
				reason: "timed out",
			});
		}
		expect(logLatency).toHaveBeenCalledTimes(7 + DEGRADATION_ENTRIES_PER_KIND);
	});

	it("reset re-arms durable once-recording", () => {
		const record = {
			kind: "formatter-failure" as const,
			subject: "prettier:a.ts",
			reason: "timed out",
		};
		recordDegradationOnce(record);
		resetDegradationLedger();
		recordDegradationOnce(record);

		expect(logLatency).toHaveBeenCalledTimes(2);
		expect(logLatency.mock.calls.map(([row]) => row.metadata.count)).toEqual([
			1, 1,
		]);
		expect(logLatency.mock.calls[0][0].metadata.ledgerGeneration).not.toBe(
			logLatency.mock.calls[1][0].metadata.ledgerGeneration,
		);
	});

	it("renders a health section only when degraded", () => {
		expect(renderDegradationLines()).toEqual([]);
		recordDegradation({
			kind: "grammar-blocked",
			subject: "swift.wasm",
			reason: "runtime unsafe",
		});
		expect(renderDegradationLines()).toEqual([
			"Degradations:",
			"  ⚠ grammar-blocked: 1 — swift.wasm: runtime unsafe",
		]);
	});

	// #2505 review: a routine rotation at the configured bound is the sink
	// working as designed. Flagging it with the same warning marker a real
	// degradation gets trains the reader to ignore the marker; the FAILED
	// rotation (the sink cannot bound itself, so the file grows) is the line
	// that has to stand out.
	it("renders a routine sink rotation informationally and a failed one as a warning", () => {
		const sink = "read-guard.log";
		const lines = renderDegradationLines([
			{
				kind: "log-sink-rotated",
				count: 3,
				droppedCount: 0,
				latestReasons: [
					{ subject: sink, reason: "3 rotations at the byte bound" },
				],
			},
			{
				kind: "log-sink-rotate-failed",
				count: 2,
				droppedCount: 0,
				latestReasons: [
					{ subject: sink, reason: "2 failed rotations, sink still growing" },
				],
			},
		]);
		expect(lines[0]).toBe("Degradations:");
		expect(lines[1]).toBe("  log-sink-rotated: 3");
		expect(lines[1]).not.toContain("⚠");
		expect(lines[2]).toContain("⚠ log-sink-rotate-failed: 2");
		expect(lines[2]).toContain(sink);
	});

	// #2504 review round 8 (S1): both actionable-warnings carry-forward drops
	// fire on the ordinary re-edit cadence and self-heal on the next turn's
	// analysis or deferral, so they get the same informational treatment as a
	// routine log rotation -- no `⚠`.
	it("renders both actionable-warnings carry-forward drops informationally", () => {
		const lines = renderDegradationLines([
			{
				kind: "actionable-warnings-inband-superseded",
				count: 1,
				droppedCount: 0,
				latestReasons: [
					{
						subject: "/repo:inband-carry-superseded",
						reason:
							"1 carried-forward deferred file entry changed before this turn's in-band publish could keep them (src/a.ts)",
					},
				],
			},
			{
				kind: "actionable-warnings-deferred-superseded",
				count: 1,
				droppedCount: 0,
				latestReasons: [
					{
						subject: "/repo:deferred-file-superseded",
						reason:
							"1 file(s) changed while the deferred LSP pull was reading them (src/b.ts)",
					},
				],
			},
		]);
		expect(lines[1]).toBe("  actionable-warnings-inband-superseded: 1");
		expect(lines[1]).not.toContain("⚠");
		expect(lines[2]).toBe("  actionable-warnings-deferred-superseded: 1");
		expect(lines[2]).not.toContain("⚠");
	});
	it("renders newly wired degradation kinds", () => {
		recordDegradation({
			kind: "formatter-failure",
			subject: "prettier:a.ts",
			reason: "timed out",
		});
		expect(renderDegradationLines().at(-1)).toContain("formatter-failure: 1");
	});

	// #1366 review: reasons carry arbitrary error text -- bounded at record
	// time so health lines and retained strings stay small.
	it("truncates oversized subjects and reasons at record time", () => {
		resetDegradationLedger();
		recordDegradation({
			kind: "trust-refusal",
			subject: "s".repeat(500),
			reason: "r".repeat(10_000),
		});
		const [group] = getDegradationSummary();
		const latest = group.latestReasons.at(-1)!;
		expect(latest.subject.length).toBeLessThanOrEqual(201);
		expect(latest.reason.length).toBeLessThanOrEqual(201);
		const lines = renderDegradationLines();
		expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(500);
	});

	it("normalizes undefined subjects without breaking either recording path", () => {
		expect(() =>
			recordDegradation({
				kind: "spawn-failure",
				subject: undefined,
				reason: undefined,
			}),
		).not.toThrow();
		expect(() =>
			incrementDegradationCount({
				kind: "lsp-diagnostics-timeout",
				subject: undefined,
				reason: undefined,
			}),
		).not.toThrow();
		expect(getDegradationSummary()).toEqual([
			{
				kind: "spawn-failure",
				count: 1,
				droppedCount: 0,
				latestReasons: [{ subject: "unknown", reason: "unknown" }],
			},
			{
				kind: "lsp-diagnostics-timeout",
				count: 1,
				droppedCount: 0,
				latestReasons: [{ subject: "unknown", reason: "unknown (count: 1)" }],
			},
		]);
	});

	it("bounds distinct kinds and truncates oversized kinds", () => {
		for (let i = 0; i < 100; i++) {
			recordDegradation({ kind: `garbage-${i}`, subject: "s", reason: "r" });
		}
		expect(getDegradationSummary()).toHaveLength(
			DEGRADATION_MAX_DISTINCT_KINDS,
		);
		expect(() => renderDegradationLines()).not.toThrow();

		resetDegradationLedger();
		recordDegradation({ kind: "k".repeat(10_000), subject: "s", reason: "r" });
		expect(getDegradationSummary()[0].kind.length).toBeLessThanOrEqual(201);
	});

	it("swallows failures caused by corrupted telemetry input", () => {
		const corrupted = {
			toString: () => {
				throw new Error("corrupted ledger value");
			},
		};
		expect(() =>
			recordDegradation({
				kind: "spawn-failure",
				subject: corrupted,
				reason: "ignored",
			}),
		).not.toThrow();
		expect(() =>
			recordDegradationOnce({
				kind: "spawn-failure",
				subject: corrupted,
				reason: "ignored",
			}),
		).not.toThrow();
		expect(() =>
			incrementDegradationCount({
				kind: "spawn-failure",
				subject: "ok",
				reason: corrupted,
			}),
		).not.toThrow();
		expect(
			vi
				.mocked(logExtension)
				.mock.calls.filter(
					([entry]) =>
						entry.level === "debug" && entry.subsystem === "degradation-ledger",
				),
		).toHaveLength(3);
	});

	it.each([null, undefined, { malformed: true }, [{ kind: "bad" }]])(
		"renders malformed summary %p as empty",
		(summary) => {
			expect(renderDegradationLines(summary)).toEqual([]);
		},
	);

	describe("log-sink-write-failure (#1970)", () => {
		it("folds a real ndjson-logger sink loss into the summary, naming the sink and its dropped-write count", async () => {
			const ndjson = await import("../../clients/ndjson-logger.js");
			const path = await import("node:path");
			const os = await import("node:os");
			const fs = await import("node:fs");
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "degradation-ledger-sink-fold-"),
			);
			const logFile = path.join(tmpDir, "test.log");

			// Nothing to fold before any sink has failed.
			expect(
				getDegradationSummary().some(
					(g) => g.kind === "log-sink-write-failure",
				),
			).toBe(false);

			const err = Object.assign(new Error("destroyed"), {
				code: "ERR_STREAM_DESTROYED",
			});
			const appendFileSpy = vi
				.spyOn(fs.promises, "appendFile")
				.mockRejectedValue(err);
			const logger = ndjson.createNdjsonLogger({ filePath: logFile });
			logger.log({ lost: true });
			await logger.flush();
			appendFileSpy.mockRestore();

			// The fold is live data read from ndjson-logger's own tally, not a
			// static/empty entry: it names the sink and carries a real count.
			const group = getDegradationSummary().find(
				(g) => g.kind === "log-sink-write-failure",
			);
			expect(group).toBeDefined();
			expect(group?.count).toBeGreaterThanOrEqual(1);
			const entry = group?.latestReasons.find((r) =>
				r.subject.includes("test.log"),
			);
			expect(entry).toBeDefined();
			expect(entry?.reason).toContain("dropped write");

			ndjson.resetSinkWriteFailures();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("session-boundary reset clears the sink write-failure tally (catalog shape 17)", async () => {
			const ndjson = await import("../../clients/ndjson-logger.js");
			const path = await import("node:path");
			const os = await import("node:os");
			const fs = await import("node:fs");
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "degradation-ledger-sink-"),
			);
			const logFile = path.join(tmpDir, "test.log");
			const appendFileSpy = vi
				.spyOn(fs.promises, "appendFile")
				.mockRejectedValue(
					Object.assign(new Error("destroyed"), {
						code: "ERR_STREAM_DESTROYED",
					}),
				);
			const logger = ndjson.createNdjsonLogger({ filePath: logFile });
			logger.log({ lost: true });
			await logger.flush();
			appendFileSpy.mockRestore();

			expect(
				getDegradationSummary().some(
					(g) => g.kind === "log-sink-write-failure",
				),
			).toBe(true);

			resetDegradationLedger();

			expect(
				getDegradationSummary().some(
					(g) => g.kind === "log-sink-write-failure",
				),
			).toBe(false);

			fs.rmSync(tmpDir, { recursive: true, force: true });
		});
	});
});
