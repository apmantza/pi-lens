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
	LEDGER_FIELD_MAX,
	_getDegradationLedgerStateForTests,
	getDegradationLedgerGeneration,
	getDegradationSummary,
	incrementDegradationCount,
	recordDegradation,
	recordDegradationOnce,
	renderDegradationLines,
	resetDegradationLedger,
	truncateForLedger,
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

	// #3952 review (F4): both idle-eviction kinds are the POLICY answering, not
	// a timer that failed. The decline fires for every non-`transparent` server
	// on every acquisition (32 of the 49 built-ins), so a `⚠` per server would
	// mark a nominal session: a tally, like a routine log rotation. Driven
	// through the ledger's own write path, so the render reads the real record.
	it("renders both idle-eviction kinds informationally, with no warning marker", () => {
		recordDegradationOnce({
			kind: "lsp-idle-eviction-declined",
			subject: "typos",
			reason: "no idle-eviction timer: declared unmeasured",
		});
		recordDegradation({
			kind: "lsp-idle-eviction",
			subject: "ts:/repo:a.ts",
			reason: "idle LSP client released to bound memory",
		});
		const lines = renderDegradationLines();
		const lineFor = (kind: string) =>
			lines.find((line) => line.startsWith(`  ${kind}:`));
		expect(lineFor("lsp-idle-eviction")).toBe("  lsp-idle-eviction: 1");
		expect(lineFor("lsp-idle-eviction-declined")).toBe(
			"  lsp-idle-eviction-declined: 1",
		);
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
				path.join(os.tmpdir(), "pi-lens-degradation-ledger-sink-fold-"),
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
				path.join(os.tmpdir(), "pi-lens-degradation-ledger-sink-"),
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

describe("a blank subject is the same as a missing one (#3389 verify round 2)", () => {
	// Recurrence this guards: F3395-02. `normalizeForLedger` maps `null` and
	// `undefined` to `"unknown"` but deliberately KEEPS falsy primitives, so a
	// caller handing over an empty string — a socket error whose `code` is `""`
	// — wrote `subject: ""`, a row that discriminates nothing and renders as
	// `⚠ kind: 1 — : reason`. A subject is an identity, so blank and missing
	// are one case; a metadata VALUE of `""` is data and stays untouched, which
	// is why the rule lives here and not in `normalizeForLedger`.
	it.each([
		["empty", ""],
		["whitespace only", "   "],
		["tab and newline", "\t\n"],
	])("writes unknown for a %s subject on every write path", (_label, blank) => {
		recordDegradation({ kind: "spawn-failure", subject: blank, reason: "a" });
		recordDegradationOnce({
			kind: "trust-refusal",
			subject: blank,
			reason: "b",
		});
		incrementDegradationCount({
			kind: "runner-parsed-nothing",
			subject: blank,
			reason: "c",
		});

		const subjects = getDegradationSummary().map(
			(group) => group.latestReasons[0]?.subject,
		);
		expect(subjects).toEqual(["unknown", "unknown", "unknown"]);
	});

	it("keeps a falsy but informative subject", () => {
		// The over-reach direction: `0` and `false` NAME something, so the blank
		// rule must read the normalized text, not the caller's truthiness.
		recordDegradation({ kind: "spawn-failure", subject: 0, reason: "zero" });
		recordDegradation({ kind: "trust-refusal", subject: false, reason: "no" });

		expect(
			getDegradationSummary().map((group) => group.latestReasons[0]?.subject),
		).toEqual(["0", "false"]);
	});

	it("still renders an OLD row that was written with an empty subject", () => {
		// Old-record proof for the write-side change: the fold applies when a row
		// is WRITTEN, and nothing rewrites stored rows. A summary carried over
		// from a session that recorded `subject: ""` — the shape this PR stops
		// producing — must still parse and render exactly as it did before.
		expect(
			renderDegradationLines([
				{
					kind: "warm-attach-socket-error",
					count: 1,
					droppedCount: 0,
					latestReasons: [{ subject: "", reason: "Error: malformed errno" }],
				},
			]),
		).toEqual([
			"Degradations:",
			"  ⚠ warm-attach-socket-error: 1 — : Error: malformed errno",
		]);
	});

	it("keys the once-latch and the tally by the normalized subject", () => {
		// Two blank spellings are ONE row, not two: the key is derived from the
		// same normalization the row carries, so a peer that reports `""` once
		// and `"  "` next does not split its own tally.
		incrementDegradationCount({
			kind: "spawn-failure",
			subject: "",
			reason: "a",
		});
		incrementDegradationCount({
			kind: "spawn-failure",
			subject: "  ",
			reason: "b",
		});
		recordDegradationOnce({ kind: "trust-refusal", subject: "", reason: "c" });
		recordDegradationOnce({
			kind: "trust-refusal",
			subject: "\t",
			reason: "d",
		});

		const summary = getDegradationSummary();
		const counted = summary.find((group) => group.kind === "spawn-failure");
		const once = summary.find((group) => group.kind === "trust-refusal");
		expect(counted?.count).toBe(2);
		expect(counted?.latestReasons).toEqual([
			{ subject: "unknown", reason: "b (count: 2)" },
		]);
		expect(once?.count).toBe(1);
		expect(once?.latestReasons).toEqual([{ subject: "unknown", reason: "c" }]);
	});
});

// Named recurrence (#5359): the once-key is an event IDENTITY and was built
// from `subjectForLedger`, the TRUNCATED subject the retained row carries. Two
// genuinely distinct events whose subjects share their first
// `LEDGER_FIELD_MAX` characters therefore deduped to one and the second was
// silently dropped — the shape the #5246 tsserver cell hit when a long TMPDIR
// pushed two `typescript-compiler:g<n>:<cwd>` subjects past the cut. The fix
// keys the once-set on the full subject (hashed, so an entry stays fixed-size)
// while the retained row keeps its bounded text.
describe("recordDegradationOnce keys on the full subject (#5359)", () => {
	// Two path-shaped subjects of a real long-checkout length that share their
	// first 200 characters and differ only in the tail.
	const longBase = `typescript-compiler:g0:${"a".repeat(190)}`;
	const longA = `${longBase}/first-project`;
	const longB = `${longBase}/second-project`;

	it("admits two events whose subjects differ only past the retained bound", () => {
		// Precondition, asserted so the case cannot rot into a short-subject one:
		// distinct subjects, both past the bound, identical once truncated.
		expect(longA).not.toBe(longB);
		expect(longA.length).toBeGreaterThan(LEDGER_FIELD_MAX);
		expect(longB.length).toBeGreaterThan(LEDGER_FIELD_MAX);
		expect(truncateForLedger(longA)).toBe(truncateForLedger(longB));

		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: longA,
				reason: "first root",
			}),
		).toBe(true);
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: longB,
				reason: "second root",
			}),
		).toBe(true);

		const summary = getDegradationSummary();
		const rows = summary.filter(
			(group) => group.kind === "lsp-registry-decision",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.count).toBe(2);
		// The RETAINED text stays bounded: the fix changes the key, not the row.
		expect(rows[0]?.latestReasons).toEqual([
			{ subject: truncateForLedger(longA), reason: "first root" },
			{ subject: truncateForLedger(longB), reason: "second root" },
		]);
		for (const entry of rows[0]?.latestReasons ?? []) {
			expect(entry.subject.length).toBeLessThanOrEqual(LEDGER_FIELD_MAX + 1);
		}
		const state = _getDegradationLedgerStateForTests();
		expect(state.retainedEntries).toBe(2);
		expect(state.onceKeys).toBe(2);

		// The durable sink sees the same two events, each with the BOUNDED subject:
		// the fix changes the key, never what a row carries.
		expect(
			vi
				.mocked(logLatency)
				.mock.calls.filter(([row]) => row.phase === "degradation_ledger")
				.map(([row]) => row.metadata),
		).toEqual([
			expect.objectContaining({
				kind: "lsp-registry-decision",
				subject: truncateForLedger(longA),
				count: 1,
			}),
			expect.objectContaining({
				kind: "lsp-registry-decision",
				subject: truncateForLedger(longB),
				count: 1,
			}),
		]);
	});

	it("still dedupes the same long subject within the session", () => {
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: longA,
				reason: "first",
			}),
		).toBe(true);
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: longA,
				reason: "repeat",
			}),
		).toBe(false);

		const row = getDegradationSummary().find(
			(group) => group.kind === "lsp-registry-decision",
		);
		expect(row?.count).toBe(1);
		expect(row?.latestReasons).toEqual([
			{ subject: truncateForLedger(longA), reason: "first" },
		]);
	});

	it("keeps short-subject dedupe unchanged", () => {
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: "typescript-compiler:g0:alpha",
				reason: "a",
			}),
		).toBe(true);
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: "typescript-compiler:g0:beta",
				reason: "b",
			}),
		).toBe(true);
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: "typescript-compiler:g0:alpha",
				reason: "a again",
			}),
		).toBe(false);

		const row = getDegradationSummary().find(
			(group) => group.kind === "lsp-registry-decision",
		);
		expect(row?.count).toBe(2);
		expect(_getDegradationLedgerStateForTests().onceKeys).toBe(2);
	});

	it("admits two distinct kinds that both overflow the kind cardinality bound", () => {
		// Sibling of the same identity rule (#5359 step 3): `boundedKind` folds
		// every kind past the cardinality bound into "other", which is correct for
		// the GROUP population but must not fold the once-key — these two real
		// opengrep kinds fire on the same cwd and are two distinct events.
		for (let i = 0; i < DEGRADATION_MAX_DISTINCT_KINDS - 1; i++) {
			recordDegradation({
				kind: `filler-kind-${i}`,
				subject: "filler",
				reason: "r",
			});
		}
		const cwd = "/home/dev/checkouts/project";

		expect(
			recordDegradationOnce({
				kind: "opengrep-partial-scan",
				subject: cwd,
				reason: "partial",
			}),
		).toBe(true);
		expect(
			recordDegradationOnce({
				kind: "opengrep-scan-refused",
				subject: cwd,
				reason: "refused",
			}),
		).toBe(true);

		const row = getDegradationSummary().find((group) => group.kind === "other");
		// Both land in the one overflow group (the cardinality bound still holds),
		// and both are counted.
		expect(row?.count).toBe(2);
		expect(row?.latestReasons).toEqual([
			{ subject: cwd, reason: "partial" },
			{ subject: cwd, reason: "refused" },
		]);
	});
});

// Named recurrence (#5359 review F1): `incrementDegradationCount` answers the
// same "first occurrence of this event" question as `recordDegradationOnce`,
// and ten call sites gate a one-time log line on its return value. Its tally
// map was keyed on the TRUNCATED subject and the cardinality-folded kind, so
// the rising edge was lost for exactly the two shapes #5359 fixes above — two
// file paths sharing their first `LEDGER_FIELD_MAX` characters, and two
// distinct kinds past the 32-kind cap on one subject. The key now goes through
// `onceKey`; the retained row keeps the bounded display identity.
describe("incrementDegradationCount keys on the full subject (#5359 F1)", () => {
	// Two `subject: filePath` shapes (the read-guard form) that share their
	// first 200 characters and differ only in the tail.
	const tallBase = `read-guard:${"c".repeat(190)}`;
	const tallA = `${tallBase}/first-project`;
	const tallB = `${tallBase}/second-project`;

	it("returns the rising edge for two subjects that differ only past the retained bound", () => {
		// Precondition, asserted so the case cannot rot into a short-path one.
		expect(tallA).not.toBe(tallB);
		expect(tallA.length).toBeGreaterThan(LEDGER_FIELD_MAX);
		expect(truncateForLedger(tallA)).toBe(truncateForLedger(tallB));

		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: tallA,
				reason: "first file",
			}),
		).toBe(true);
		// Pre-fix this read `false`: the second file's one-time line never fired.
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: tallB,
				reason: "second file",
			}),
		).toBe(true);
		// A repeat of either is still not a rising edge.
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: tallA,
				reason: "first file again",
			}),
		).toBe(false);

		// Two tallies, so each path keeps its own count; the RETAINED row stays
		// keyed by the bounded display identity, so the two paths share one slot
		// and the `(count: N)` suffix carries the latest tally.
		expect(_getDegradationLedgerStateForTests().tallies).toBe(2);
		const row = getDegradationSummary().find(
			(group) => group.kind === "read-guard",
		);
		expect(row?.count).toBe(3);
		expect(row?.latestReasons).toEqual([
			{
				subject: truncateForLedger(tallA),
				reason: "first file again (count: 2)",
			},
		]);
	});

	it("returns the rising edge for two distinct kinds that both overflow the kind bound", () => {
		for (let i = 0; i < DEGRADATION_MAX_DISTINCT_KINDS - 1; i++) {
			recordDegradation({
				kind: `filler-kind-${i}`,
				subject: "filler",
				reason: "r",
			});
		}
		const filePath = "/home/dev/checkouts/project/src/app.ts";

		expect(
			incrementDegradationCount({
				kind: "opengrep-partial-scan",
				subject: filePath,
				reason: "partial",
			}),
		).toBe(true);
		// Pre-fix this read `false`: `boundedKind` folded both kinds into "other",
		// so the second kind shared the first kind's tally.
		expect(
			incrementDegradationCount({
				kind: "opengrep-scan-refused",
				subject: filePath,
				reason: "refused",
			}),
		).toBe(true);
		expect(
			incrementDegradationCount({
				kind: "opengrep-partial-scan",
				subject: filePath,
				reason: "partial again",
			}),
		).toBe(false);

		expect(_getDegradationLedgerStateForTests().tallies).toBe(2);
		const row = getDegradationSummary().find((group) => group.kind === "other");
		// The cardinality bound still holds: one overflow group, exact total count.
		expect(row?.count).toBe(3);
		expect(row?.latestReasons).toEqual([
			{ subject: filePath, reason: "partial again (count: 2)" },
		]);
	});

	it("keeps short-subject tallies and the session reset unchanged", () => {
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: "/repo/a.ts",
				reason: "a",
			}),
		).toBe(true);
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: "/repo/b.ts",
				reason: "b",
			}),
		).toBe(true);
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: "/repo/a.ts",
				reason: "a again",
			}),
		).toBe(false);
		expect(_getDegradationLedgerStateForTests().tallies).toBe(2);

		// Same bound class as `onceKeys`: cleared by the `session_start` reset.
		resetDegradationLedger();
		expect(_getDegradationLedgerStateForTests().tallies).toBe(0);
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: "/repo/a.ts",
				reason: "next session",
			}),
		).toBe(true);
	});
});

// Named recurrence (#5359 review r3, Qodo C1.1-C3.1). C1.1: the once-key was
// armed from one conversion of the raw subject, and the bounded display fields
// converted it again afterwards, so a second conversion that threw left an
// armed key with no record. C2.1: the key hashed the UTF-8 bytes of the text,
// which folds a lone surrogate into U+FFFD, so two different subjects shared a
// key. C3.1: the key joined kind and subject with a NUL byte, so a NUL inside
// either one let two different pairs produce the same key. Both record paths
// are covered: `recordDegradationOnce` and `incrementDegradationCount`.
describe("the once-key is derived from one normalization pass (#5359 r3)", () => {
	// A subject whose first conversion succeeds and whose later ones throw. The
	// conversion count is the variable: the defect lives in the order of calls.
	function convertsOnceThenThrows(text: string) {
		let calls = 0;
		return {
			toString() {
				calls += 1;
				if (calls > 1) throw new Error("conversion failed after the first");
				return text;
			},
		};
	}

	// A subject whose first conversion throws and whose later ones succeed.
	function throwsThenConverts(text: string) {
		let calls = 0;
		return {
			toString() {
				calls += 1;
				if (calls === 1) throw new Error("first conversion failed");
				return text;
			},
		};
	}

	it("records a subject that converts once, even when a later conversion throws", () => {
		// Pre-fix this read `false`: the key was armed by the first conversion,
		// the bounded subject threw on the second, and the event was dropped.
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: convertsOnceThenThrows("/repo/once.ts"),
				reason: "armed then thrown",
			}),
		).toBe(true);
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "lsp-registry-decision",
			)?.latestReasons,
		).toEqual([{ subject: "/repo/once.ts", reason: "armed then thrown" }]);
	});

	it("arms no once-key when the first conversion throws, so an equal subject is admitted", () => {
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: throwsThenConverts("/repo/first.ts"),
				reason: "first conversion failed",
			}),
		).toBe(false);
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: "/repo/first.ts",
				reason: "well-behaved",
			}),
		).toBe(true);
	});

	it("admits a lone surrogate and a replacement character as two events", () => {
		// Pre-fix the UTF-8 hash mapped both to the same bytes, so the second read
		// `false`. The key now hashes a JSON encoding, which escapes the surrogate.
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: "x\uD800",
				reason: "lone surrogate",
			}),
		).toBe(true);
		expect(
			recordDegradationOnce({
				kind: "lsp-registry-decision",
				subject: "x�",
				reason: "replacement character",
			}),
		).toBe(true);
	});

	it("admits a NUL-bearing kind/subject pair apart from a shifted pair", () => {
		// Pre-fix both pairs hashed `k\0a\0b`, so the second read `false`.
		expect(
			recordDegradationOnce({
				kind: "k\0a",
				subject: "b",
				reason: "first pair",
			}),
		).toBe(true);
		expect(
			recordDegradationOnce({
				kind: "k",
				subject: "a\0b",
				reason: "shifted pair",
			}),
		).toBe(true);
	});

	it("returns the rising edge and keeps the row when a later conversion throws", () => {
		// Pre-fix this read `false` with no row: the tally was not reached, so
		// the event was dropped with no record and no rising edge.
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: convertsOnceThenThrows("/repo/tally.ts"),
				reason: "armed then thrown",
			}),
		).toBe(true);
		expect(
			getDegradationSummary().find((group) => group.kind === "read-guard")
				?.latestReasons,
		).toEqual([
			{ subject: "/repo/tally.ts", reason: "armed then thrown (count: 1)" },
		]);
	});

	it("returns the rising edge for a subject whose first conversion throws, once a later one succeeds", () => {
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: throwsThenConverts("/repo/tally-first.ts"),
				reason: "first conversion failed",
			}),
		).toBe(false);
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: "/repo/tally-first.ts",
				reason: "well-behaved",
			}),
		).toBe(true);
	});

	it("returns the rising edge for a lone surrogate and a replacement character", () => {
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: "x\uD800",
				reason: "lone surrogate",
			}),
		).toBe(true);
		expect(
			incrementDegradationCount({
				kind: "read-guard",
				subject: "x�",
				reason: "replacement character",
			}),
		).toBe(true);
	});

	it("returns the rising edge for a NUL-bearing kind/subject pair apart from a shifted pair", () => {
		expect(
			incrementDegradationCount({
				kind: "k\0a",
				subject: "b",
				reason: "first pair",
			}),
		).toBe(true);
		expect(
			incrementDegradationCount({
				kind: "k",
				subject: "a\0b",
				reason: "shifted pair",
			}),
		).toBe(true);
	});
});
