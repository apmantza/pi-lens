/**
 * Unit tests for the #2001/#2002 collect-later pending store
 * (`clients/lsp/pending-aux-coverage.ts`).
 *
 * The store is the bounded hand-off between the aux-grace producer
 * (`clients/lsp/index.ts`) and the turn-end consumer
 * (`clients/runtime-turn.ts`). These tests pin its contract: bounded pair
 * count with oldest-eviction, freshness-baseline preservation across re-arm,
 * and path-key normalization so mixed-separator spellings of one file share
 * one entry (the #210 path-key class).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_LATE_AUX_REARM_TTL_MS,
	MAX_PENDING_AUX_ENTRIES,
	clearPendingAuxiliaryCoverage,
	drainPendingAuxiliaryCoverage,
	isPendingAuxiliaryPastRearmTtl,
	markPendingAuxiliaryCoverage,
	pendingAuxiliaryCoverageSizeForTests,
	readLateAuxRearmTtlMs,
	resetPendingAuxiliaryCoverage,
} from "../../../clients/lsp/pending-aux-coverage.js";

beforeEach(() => {
	resetPendingAuxiliaryCoverage();
});

afterEach(() => {
	delete process.env.PI_LENS_LATE_AUX_REARM_TTL_MS;
});

describe("pending auxiliary coverage store (#2001/#2002)", () => {
	it("drains marked pairs and empties the store", () => {
		markPendingAuxiliaryCoverage("C:/proj/src/a.ts", ["opengrep"], 1000);
		markPendingAuxiliaryCoverage("C:/proj/src/a.ts", ["typos"], 2000);

		expect(pendingAuxiliaryCoverageSizeForTests()).toBe(2);
		const drained = drainPendingAuxiliaryCoverage();
		expect(pendingAuxiliaryCoverageSizeForTests()).toBe(0);
		expect(drained.map((e) => e.serverId).sort()).toEqual([
			"opengrep",
			"typos",
		]);
		// Original display spelling survives; only keys are normalized.
		expect(drained.every((e) => e.filePath === "C:/proj/src/a.ts")).toBe(true);
		expect(drained.find((e) => e.serverId === "opengrep")?.markedAtMs).toBe(
			1000,
		);
	});

	it("re-marking an existing pair BUMPS its markedAtMs (#2027 review)", () => {
		// #2027 round-1 P2-1: the baseline must advance when a newer touch
		// re-marks, so post-baseline mtimes don't falsely read as stale and
		// drop current-revision findings.
		markPendingAuxiliaryCoverage("/w/a.ts", ["opengrep"], 1111);
		markPendingAuxiliaryCoverage("/w/a.ts", ["opengrep"], 9999);

		const drained = drainPendingAuxiliaryCoverage();
		expect(drained).toHaveLength(1);
		expect(drained[0].markedAtMs).toBe(9999);
	});

	it("clearPendingAuxiliaryCoverage removes exactly one pair", () => {
		markPendingAuxiliaryCoverage("/w/a.ts", ["opengrep", "typos"], 1000);
		clearPendingAuxiliaryCoverage("/w/a.ts", "opengrep");

		const drained = drainPendingAuxiliaryCoverage();
		expect(drained.map((e) => e.serverId)).toEqual(["typos"]);
	});

	it("mixed-separator spellings of one file share one pair per server", () => {
		// Same-case, cross-separator: the #210 path-key class. Keys fold through
		// normalizeEphemeralMapKey, so these two marks are ONE pair.
		markPendingAuxiliaryCoverage("C:\\proj\\src\\a.ts", ["opengrep"], 1000);
		markPendingAuxiliaryCoverage("C:/proj/src/a.ts", ["opengrep"], 2000);

		expect(pendingAuxiliaryCoverageSizeForTests()).toBe(1);
		const drained = drainPendingAuxiliaryCoverage();
		expect(drained[0].markedAtMs).toBe(2000); // newer mark bumps baseline
	});

	it("evicts the OLDEST pair beyond the cap (bounded store, shape 9)", () => {
		expect(MAX_PENDING_AUX_ENTRIES).toBeLessThanOrEqual(50);
		for (let i = 0; i < MAX_PENDING_AUX_ENTRIES + 5; i++) {
			markPendingAuxiliaryCoverage(`/w/file${i}.ts`, ["opengrep"], i);
		}
		expect(pendingAuxiliaryCoverageSizeForTests()).toBe(
			MAX_PENDING_AUX_ENTRIES,
		);
		const drained = drainPendingAuxiliaryCoverage();
		// The first-marked pairs were evicted; the newest survive.
		expect(drained.some((e) => e.filePath === "/w/file0.ts")).toBe(false);
		expect(
			drained.some(
				(e) => e.filePath === `/w/file${MAX_PENDING_AUX_ENTRIES + 4}.ts`,
			),
		).toBe(true);
	});

	it("re-arming a pair refreshes eviction recency without moving the baseline", () => {
		for (let i = 0; i < MAX_PENDING_AUX_ENTRIES; i++) {
			markPendingAuxiliaryCoverage(`/w/file${i}.ts`, ["opengrep"], i);
		}
		// Re-mark the OLDEST entry: it must jump to the back of the eviction
		// order AND keep its original timestamp.
		markPendingAuxiliaryCoverage("/w/file0.ts", ["opengrep"], 0);
		// One more insert forces one eviction — of file1, not the re-armed file0.
		markPendingAuxiliaryCoverage("/w/overflow.ts", ["opengrep"], 10_000);
		expect(pendingAuxiliaryCoverageSizeForTests()).toBe(
			MAX_PENDING_AUX_ENTRIES,
		);

		const drained = drainPendingAuxiliaryCoverage();
		expect(drained.some((e) => e.filePath === "/w/file0.ts")).toBe(true);
		expect(drained.some((e) => e.filePath === "/w/file1.ts")).toBe(false);
		const file0 = drained.find((e) => e.filePath === "/w/file0.ts");
		expect(file0?.markedAtMs).toBe(0);
	});

	it("re-arming stamps lastRearmedAtMs without moving the baseline", () => {
		markPendingAuxiliaryCoverage("/w/a.ts", ["opengrep"], 1000);
		markPendingAuxiliaryCoverage("/w/a.ts", ["opengrep"], 1000, 5000);

		const drained = drainPendingAuxiliaryCoverage();
		expect(drained).toHaveLength(1);
		// The freshness baseline is immutable under re-arm...
		expect(drained[0].markedAtMs).toBe(1000);
		// ...while the TTL anchor advances to the re-arm instant.
		expect(drained[0].lastRearmedAtMs).toBe(5000);
	});

	it("a producer re-mark after a re-arm resets the TTL anchor to its own mark", () => {
		// A newer touch marks a NEWER revision; the stale re-arm stamp from the
		// previous revision's probes must not shorten (anchor older than mark)
		// or silently extend the NEW pair's window.
		markPendingAuxiliaryCoverage("/w/a.ts", ["opengrep"], 1000);
		markPendingAuxiliaryCoverage("/w/a.ts", ["opengrep"], 1000, 5000);
		markPendingAuxiliaryCoverage("/w/a.ts", ["opengrep"], 9000);

		const drained = drainPendingAuxiliaryCoverage();
		expect(drained[0].markedAtMs).toBe(9000);
		expect(drained[0].lastRearmedAtMs).toBeUndefined();
	});

	it("rearmTtl expiry anchors on the re-arm stamp, not the original mark", () => {
		process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
		const now = 1_000_000;
		const pair = {
			filePath: "/w/a.ts",
			serverId: "opengrep",
			markedAtMs: now - 10_000, // far past a 5s TTL from the mark
		};
		expect(isPendingAuxiliaryPastRearmTtl(pair, now)).toBe(true);

		// The same pair re-armed recently stays IN window despite its old mark.
		const rearmed = { ...pair, lastRearmedAtMs: now - 1_000 };
		expect(isPendingAuxiliaryPastRearmTtl(rearmed, now)).toBe(false);

		// But it expires again once the re-arm itself ages past the TTL.
		const aged = { ...pair, lastRearmedAtMs: now - 6_000 };
		expect(isPendingAuxiliaryPastRearmTtl(aged, now)).toBe(true);
	});

	it("exposes a positive default re-arm TTL (a zero TTL would drop every slow scanner)", () => {
		delete process.env.PI_LENS_LATE_AUX_REARM_TTL_MS;
		expect(DEFAULT_LATE_AUX_REARM_TTL_MS).toBeGreaterThan(60_000);
		expect(readLateAuxRearmTtlMs()).toBe(DEFAULT_LATE_AUX_REARM_TTL_MS);
	});

	it("reads PI_LENS_LATE_AUX_REARM_TTL_MS at call time and rejects invalid values", () => {
		process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "120000";
		expect(readLateAuxRearmTtlMs()).toBe(120_000);

		process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "not-a-number";
		expect(readLateAuxRearmTtlMs()).toBe(DEFAULT_LATE_AUX_REARM_TTL_MS);

		process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "-5";
		expect(readLateAuxRearmTtlMs()).toBe(DEFAULT_LATE_AUX_REARM_TTL_MS);
	});
});
