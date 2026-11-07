/**
 * Tests for scripts/lib/latency-log-phases.mjs — the pure NDJSON phase
 * parsing/filtering used by scripts/compat-smoke-behavioral.mjs (#476, Layer B)
 * to assert phases logged (or absent) by a real `pi` invocation.
 */

import { describe, expect, it } from "vitest";
import {
	countEntriesSince,
	findPhaseEntries,
	LEGACY_AGE_PHASES,
	latencyAgeMs,
	latencySpanMs,
	noPhasesLogged,
	parseNdjsonEntries,
	phaseWasLogged,
} from "../../scripts/lib/latency-log-phases.mjs";

describe("parseNdjsonEntries", () => {
	it("parses one JSON object per line", () => {
		const text = '{"a":1}\n{"b":2}\n';
		expect(parseNdjsonEntries(text)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("skips blank lines", () => {
		const text = '{"a":1}\n\n\n{"b":2}\n';
		expect(parseNdjsonEntries(text)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("skips malformed/truncated lines rather than throwing", () => {
		const text = '{"a":1}\n{"b":2\n{"c":3}\n';
		expect(parseNdjsonEntries(text)).toEqual([{ a: 1 }, { c: 3 }]);
	});

	it("returns [] for empty input", () => {
		expect(parseNdjsonEntries("")).toEqual([]);
	});
});

describe("findPhaseEntries / phaseWasLogged", () => {
	const entries = [
		{
			type: "phase",
			phase: "subagent_light_mode",
			ts: "2026-07-10T10:00:00.000Z",
		},
		{ type: "phase", phase: "slow_fs_probe", ts: "2026-07-10T10:00:01.000Z" },
		{
			type: "runner",
			phase: "subagent_light_mode",
			ts: "2026-07-10T10:00:02.000Z",
		},
		{
			type: "phase",
			phase: "subagent_light_mode",
			ts: "2026-07-10T09:00:00.000Z",
		},
	];

	it("finds phase entries by name, ignoring non-phase types", () => {
		const found = findPhaseEntries(entries, "subagent_light_mode");
		expect(found).toHaveLength(2);
	});

	it("restricts to entries at/after sinceIso when provided", () => {
		const found = findPhaseEntries(
			entries,
			"subagent_light_mode",
			"2026-07-10T09:30:00.000Z",
		);
		expect(found).toHaveLength(1);
		expect(found[0].ts).toBe("2026-07-10T10:00:00.000Z");
	});

	it("phaseWasLogged is true when at least one match exists", () => {
		expect(phaseWasLogged(entries, "subagent_light_mode")).toBe(true);
	});

	it("phaseWasLogged is false for a phase never logged", () => {
		expect(phaseWasLogged(entries, "concurrent_session_bind")).toBe(false);
	});

	it("phaseWasLogged is false when sinceIso excludes all matches", () => {
		expect(
			phaseWasLogged(
				entries,
				"subagent_light_mode",
				"2099-01-01T00:00:00.000Z",
			),
		).toBe(false);
	});

	it("skips entries with an unparseable ts when sinceIso is set", () => {
		const withBadTs = [{ type: "phase", phase: "x", ts: "not-a-date" }];
		expect(phaseWasLogged(withBadTs, "x", "2026-01-01T00:00:00.000Z")).toBe(
			false,
		);
	});

	// #2249: `concurrent_session_bind_rollup` (the session-end summary,
	// index.ts's session_shutdown handler) shares a prefix with
	// `concurrent_session_bind` (the per-bind record, #473). Exact-match only —
	// a naive substring/prefix check would conflate the two.
	//
	// #2312 review F2: hand-built literal objects never touch the feature — the
	// prior version of this test passed with the whole PR reverted. Drive the
	// REAL seam instead: the actual `logConcurrentSessionBind`/
	// `emitConcurrentSessionBindRollupAtSessionEnd` production functions write
	// through the real `logLatency` sink into a real NDJSON file
	// (`PI_LENS_HOME` is a per-worker temp dir, set globally by
	// tests/support/vitest-setup.ts), then `findPhaseEntries` parses that file
	// back. Deleting `session-start-observability.ts`'s exports, or its call to
	// `logLatency`, breaks this test structurally (import/behavioral failure),
	// not just a hand-maintained fixture.
	it("distinguishes concurrent_session_bind from its concurrent_session_bind_rollup sibling, driven through the real logging seam", async () => {
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			const { clearLatencyLog, flushLatencyLog, getLatencyLogPath } =
				await import("../../clients/latency-logger.js");
			const {
				logConcurrentSessionBind,
				emitConcurrentSessionBindRollupAtSessionEnd,
				resetConcurrentSessionBindRollupCounts,
			} = await import("../../clients/session-start-observability.js");
			const fs = await import("node:fs");

			resetConcurrentSessionBindRollupCounts();
			clearLatencyLog();
			await flushLatencyLog();

			// One per-bind record (#473's `concurrent_session_bind`)...
			logConcurrentSessionBind({
				secondaryCount: 1,
				sameCwd: true,
				classification: "concurrent-secondary",
			});
			// ...then the real session-end summary
			// (`concurrent_session_bind_rollup`), sharing the `concurrent_session_bind`
			// prefix.
			emitConcurrentSessionBindRollupAtSessionEnd("/tmp/f2-real-seam");
			await flushLatencyLog();

			const text = fs.readFileSync(getLatencyLogPath(), "utf8");
			const entries = parseNdjsonEntries(text);

			expect(findPhaseEntries(entries, "concurrent_session_bind")).toHaveLength(
				1,
			);
			expect(
				findPhaseEntries(entries, "concurrent_session_bind_rollup"),
			).toHaveLength(1);
			expect(phaseWasLogged(entries, "concurrent_session_bind_rollup")).toBe(
				true,
			);
		} finally {
			if (previousTestMode === undefined) {
				delete process.env.PI_LENS_TEST_MODE;
			} else {
				process.env.PI_LENS_TEST_MODE = previousTestMode;
			}
		}
	});
});

describe("noPhasesLogged", () => {
	const entries = [
		{
			type: "phase",
			phase: "heavyweight_scan_started",
			ts: "2026-07-10T10:00:00.000Z",
		},
	];

	it("is true when none of the given phases appear", () => {
		expect(noPhasesLogged(entries, ["knip_scan", "jscpd_scan"])).toBe(true);
	});

	it("is false when any given phase appears", () => {
		expect(
			noPhasesLogged(entries, ["knip_scan", "heavyweight_scan_started"]),
		).toBe(false);
	});

	it("respects sinceIso the same way phaseWasLogged does", () => {
		expect(
			noPhasesLogged(
				entries,
				["heavyweight_scan_started"],
				"2099-01-01T00:00:00.000Z",
			),
		).toBe(true);
	});
});

describe("countEntriesSince (#2570 positive control)", () => {
	const entries = [
		{ type: "phase", phase: "slow_fs_probe", ts: "2026-07-10T10:00:00.000Z" },
		{ type: "runner", phase: "x", ts: "2026-07-10T10:00:05.000Z" },
		{ type: "phase", phase: "y" }, // no ts — never counted
		{ type: "phase", phase: "z", ts: "not-a-date" },
	];

	it("counts entries of any type at or after sinceIso", () => {
		expect(countEntriesSince(entries, "2026-07-10T10:00:00.000Z")).toBe(2);
		expect(countEntriesSince(entries, "2026-07-10T10:00:01.000Z")).toBe(1);
	});

	it("is zero for an empty or mis-located log, so absence assertions cannot pass vacuously", () => {
		expect(countEntriesSince([], "2026-07-10T10:00:00.000Z")).toBe(0);
		expect(countEntriesSince(entries, "2099-01-01T00:00:00.000Z")).toBe(0);
	});
});

describe("latencySpanMs / latencyAgeMs: the one span-or-age rule (#5379)", () => {
	// Recurrence: a producer wrote an age into `durationMs` and every reader that
	// ranks phases ranked it (`lsp_document_drift`, 81.8% of a live log's phase
	// time). The rule is: a row is a duration only if it carries `durationMs` and
	// no `ageMs`; readers keep no phase-name list of their own.
	const row = (extra: Record<string, unknown>) => ({
		type: "phase",
		phase: "some_new_phase",
		filePath: "x",
		...extra,
	});

	it("reads durationMs as a span and a new-format ageMs as an age, never both", () => {
		expect(latencySpanMs(row({ durationMs: 12 }))).toBe(12);
		expect(latencyAgeMs(row({ durationMs: 12 }))).toBeUndefined();
		expect(latencyAgeMs(row({ ageMs: 9 }))).toBe(9);
		expect(latencySpanMs(row({ ageMs: 9 }))).toBeUndefined();
	});

	it("a row carrying ageMs is never a duration, even beside a durationMs", () => {
		const both = row({ ageMs: 9, durationMs: 3_000_000 });
		expect(latencySpanMs(both)).toBeUndefined();
		expect(latencyAgeMs(both)).toBe(9);
	});

	it("a malformed ageMs is neither a duration nor an age", () => {
		const bad = row({ ageMs: "soon", durationMs: 40 });
		expect(latencySpanMs(bad)).toBeUndefined();
		expect(latencyAgeMs(bad)).toBeUndefined();
	});

	it.each([...LEGACY_AGE_PHASES])(
		"a pre-#5379 %s line (age in durationMs, no ageMs) reads as an age",
		(phase) => {
			const legacy = row({ phase, durationMs: 2_760_325 });
			expect(latencySpanMs(legacy)).toBeUndefined();
			expect(latencyAgeMs(legacy)).toBe(2_760_325);
		},
	);

	it("the legacy list applies to a line without ageMs only, and to phase rows only", () => {
		const migrated = row({ phase: "lsp_document_drift", ageMs: 5 });
		expect(latencyAgeMs(migrated)).toBe(5);
		const runner = { type: "runner", phase: "host_boot", durationMs: 7 };
		expect(latencySpanMs(runner)).toBe(7);
	});

	it("pins the closed legacy list: a new age producer writes ageMs, it does not join this set", () => {
		expect([...LEGACY_AGE_PHASES].sort()).toEqual(
			[
				"deferred_format_late_resync",
				"event_loop_hold_force_released",
				"extension_loaded",
				"format_late_resync_chained",
				"host_boot",
				"inband_format_late_resync",
				"lsp_document_drift",
				"lsp_empty_first_publish_held",
				"lsp_notify_resync_deferred",
				"lsp_notify_stall_cpu_busy",
				"lsp_workspace_diagnostics_progress",
				"lsp_workspace_sweep_hold_force_released",
			].sort(),
		);
	});

	it("reads nothing from a non-object", () => {
		for (const value of [null, undefined, 3, "x"]) {
			expect(latencySpanMs(value)).toBeUndefined();
			expect(latencyAgeMs(value)).toBeUndefined();
		}
	});
});
