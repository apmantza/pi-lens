/**
 * Unit + mutation proofs for the bounded-telemetry helper (#1743).
 *
 * Each guard the helper adds gets a test that reds when the guard is deleted,
 * and each is pinned INDEPENDENTLY. #1733's review found the opposite: two
 * guards forming a compensating pair, so deleting either one left every test
 * green. The three guards here are the rising-edge gate, the per-turn cap, and
 * the identity stamp, and no one test can stand in for another.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const latencyCalls: Array<Record<string, unknown>> = [];
vi.mock("../../clients/latency-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Record<string, unknown>) => {
			latencyCalls.push(entry);
		},
	};
});

import {
	_boundedTrackedTurnsForTest,
	_boundedTurnCountForTest,
	admitBounded,
	BOUNDED_TELEMETRY_PHASES,
	emitBounded,
	resetBoundedTelemetry,
} from "../../clients/bounded-telemetry.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const PHASE = "lsp_nav_request_timeout";

function summaryFor(kind: string) {
	return getDegradationSummary().find((group) => group.kind === kind);
}

function boundedPhaseCalls(): Array<Record<string, unknown>> {
	return latencyCalls.filter((entry) => entry.phase !== "degradation_ledger");
}

describe("emitBounded (#1743)", () => {
	beforeEach(() => {
		latencyCalls.length = 0;
		resetDegradationLedger();
		resetBoundedTelemetry();
	});

	describe("rising edge", () => {
		it("writes one record per identity while counting every occurrence", () => {
			for (let i = 0; i < 5; i++) {
				emitBounded(
					PHASE,
					"hover:/a.ts",
					{ durationMs: i },
					{
						ledgerKind: "lsp-nav-request-timeout",
						risingEdgePer: "identity",
						reason: "timeout",
					},
				);
			}
			// MUTATION PROOF: delete the `if (options.risingEdgePer !== undefined
			// && !isRisingEdge) return false;` line in admitBounded and this is 5.
			expect(boundedPhaseCalls()).toHaveLength(1);
			// The ledger still holds the exact total, so the four unlogged
			// repeats are not invisible — they are counted, with identity.
			expect(summaryFor("lsp-nav-request-timeout")?.count).toBe(5);
			expect(
				summaryFor("lsp-nav-request-timeout")?.latestReasons.at(-1)?.subject,
			).toBe("hover:/a.ts");
		});

		it("gives a second identity its own edge, so one stuck file cannot hide another", () => {
			const options = {
				ledgerKind: "lsp-nav-request-timeout",
				risingEdgePer: "identity",
				reason: "timeout",
			} as const;
			emitBounded(PHASE, "hover:/a.ts", { durationMs: 1 }, options);
			emitBounded(PHASE, "hover:/a.ts", { durationMs: 2 }, options);
			emitBounded(PHASE, "hover:/b.ts", { durationMs: 3 }, options);
			// MUTATION PROOF: key the ledger subject on the phase instead of the
			// identity and /b.ts is swallowed — this drops to 1.
			expect(boundedPhaseCalls().map((e) => e.filePath)).toEqual([
				"hover:/a.ts",
				"hover:/b.ts",
			]);
		});

		it("re-arms with the ledger at the session boundary, holding no latch of its own", () => {
			const options = {
				ledgerKind: "lsp-nav-request-timeout",
				risingEdgePer: "identity",
				reason: "timeout",
			} as const;
			emitBounded(PHASE, "hover:/a.ts", { durationMs: 1 }, options);
			emitBounded(PHASE, "hover:/a.ts", { durationMs: 2 }, options);
			expect(boundedPhaseCalls()).toHaveLength(1);
			// `resetDegradationLedger` alone — the seam `handleSessionStart`
			// already calls. If the helper kept a second latch, this would still
			// be 1 after the reset, and that latch would be the #1266–#1625 bug.
			resetDegradationLedger();
			emitBounded(PHASE, "hover:/a.ts", { durationMs: 3 }, options);
			expect(boundedPhaseCalls()).toHaveLength(2);
		});

		it("emits every occurrence when no rising edge is asked for", () => {
			for (let i = 0; i < 3; i++) {
				emitBounded(
					"lsp_pull_late_answer_discarded",
					"/a.ts::bare",
					{ durationMs: i },
					{ ledgerKind: "lsp-pull-late-answer", reason: "late" },
				);
			}
			// The gate must be OPT-IN. If it fired by default, #1713's
			// every-late-answer contract would silently become once-per-file.
			expect(boundedPhaseCalls()).toHaveLength(3);
		});
	});

	describe("per-turn cap", () => {
		it("admits up to the limit within one turn and refuses the rest", () => {
			const results = [1, 2, 3, 4].map(() =>
				emitBounded(
					"loop_block",
					"<pi-lens>",
					{ durationMs: 1 },
					{ capPerTurn: { limit: 2, turnIndex: 7 } },
				),
			);
			// MUTATION PROOF: delete `if (used >= cap.limit) return false;` and
			// all four emit.
			expect(results).toEqual([true, true, false, false]);
			expect(latencyCalls).toHaveLength(2);
		});

		it("refills on the next turn", () => {
			emitBounded(
				"loop_block",
				"<pi-lens>",
				{ durationMs: 1 },
				{ capPerTurn: { limit: 1, turnIndex: 7 } },
			);
			const sameTurn = emitBounded(
				"loop_block",
				"<pi-lens>",
				{ durationMs: 1 },
				{ capPerTurn: { limit: 1, turnIndex: 7 } },
			);
			const nextTurn = emitBounded(
				"loop_block",
				"<pi-lens>",
				{ durationMs: 1 },
				{ capPerTurn: { limit: 1, turnIndex: 8 } },
			);
			// MUTATION PROOF: delete the `countedTurnIndex !== cap.turnIndex`
			// clear and `nextTurn` is false — the cap becomes a permanent latch,
			// which is exactly the "state that must re-arm hiding behind a
			// process-lifetime latch" shape.
			expect([sameTurn, nextTurn]).toEqual([false, true]);
		});

		it("does not reopen an older turn when its async result arrives late", () => {
			const emit = (turnIndex: number) =>
				emitBounded(
					"loop_block",
					`turn-${turnIndex}`,
					{ durationMs: 1 },
					{ capPerTurn: { limit: 2, turnIndex } },
				);

			expect([emit(7), emit(7), emit(8), emit(7)]).toEqual([
				true,
				true,
				true,
				false,
			]);
			expect(_boundedTurnCountForTest("loop_block", 7)).toBe(2);
			expect(_boundedTurnCountForTest("loop_block", 8)).toBe(1);
		});

		it("bounds retained turn buckets and fails closed for retired turns", () => {
			for (let turnIndex = 0; turnIndex < 80; turnIndex++) {
				expect(
					emitBounded(
						"loop_block",
						`turn-${turnIndex}`,
						{ durationMs: 1 },
						{ capPerTurn: { limit: 1, turnIndex } },
					),
				).toBe(true);
			}
			expect(_boundedTrackedTurnsForTest()).toBeLessThanOrEqual(64);
			expect(
				emitBounded(
					"loop_block",
					"late-turn-0",
					{ durationMs: 1 },
					{ capPerTurn: { limit: 1, turnIndex: 0 } },
				),
			).toBe(false);
		});

		it("counts each phase against its own budget", () => {
			emitBounded(
				"loop_block",
				"<pi-lens>",
				{ durationMs: 1 },
				{ capPerTurn: { limit: 1, turnIndex: 7 } },
			);
			const other = emitBounded(
				"lsp_pull_diagnostic_timeout",
				"/a.ts::bare",
				{ durationMs: 1 },
				{ capPerTurn: { limit: 1, turnIndex: 7 } },
			);
			// MUTATION PROOF: key `turnCounts` on the turn alone instead of the
			// phase and one noisy phase starves every other one.
			expect(other).toBe(true);
		});

		it("clears at the session boundary, because turn numbering restarts at 0", () => {
			emitBounded(
				"loop_block",
				"<pi-lens>",
				{ durationMs: 1 },
				{ capPerTurn: { limit: 1, turnIndex: 0 } },
			);
			expect(_boundedTurnCountForTest("loop_block")).toBe(1);
			// MUTATION PROOF: empty out `resetBoundedTelemetry` and this is 1, so
			// a new session's turn 0 inherits the previous session's spent budget.
			resetBoundedTelemetry();
			expect(_boundedTurnCountForTest("loop_block")).toBe(0);
			expect(
				emitBounded(
					"loop_block",
					"<pi-lens>",
					{ durationMs: 1 },
					{ capPerTurn: { limit: 1, turnIndex: 0 } },
				),
			).toBe(true);
		});
	});

	describe("identity", () => {
		it("stamps the identity into the record even when filePath is coarser", () => {
			emitBounded(
				"lsp_pull_diagnostic_timeout",
				"/a.ts::eslint",
				{
					durationMs: 5,
					filePath: "/a.ts",
					metadata: { identifier: "eslint" },
				},
				{},
			);
			const entry = latencyCalls[0];
			expect(entry.filePath).toBe("/a.ts");
			// MUTATION PROOF: drop `identity` from the metadata spread and this
			// reds. Aggregating these records by phase would then lose WHICH
			// pull source is stuck, which is the failure AGENTS.md names.
			expect((entry.metadata as Record<string, unknown>).identity).toBe(
				"/a.ts::eslint",
			);
			expect((entry.metadata as Record<string, unknown>).identifier).toBe(
				"eslint",
			);
		});

		it("defaults filePath to the identity when the payload names none", () => {
			emitBounded("loop_block", "<pi-lens>", { durationMs: 1 }, {});
			expect(latencyCalls[0].filePath).toBe("<pi-lens>");
		});

		it("carries the identity into the ledger subject, unmodified", () => {
			emitBounded(
				PHASE,
				"definition:/deep/path.ts",
				{ durationMs: 1 },
				{
					ledgerKind: "lsp-nav-request-timeout",
					risingEdgePer: "identity",
					reason: "timeout",
				},
			);
			expect(
				summaryFor("lsp-nav-request-timeout")?.latestReasons.at(-1)?.subject,
			).toBe("definition:/deep/path.ts");
		});
	});

	describe("admitBounded", () => {
		it("counts and decides without writing a record", () => {
			const first = admitBounded(PHASE, "hover:/a.ts", {
				ledgerKind: "lsp-nav-request-timeout",
				risingEdgePer: "identity",
				reason: "timeout",
			});
			const second = admitBounded(PHASE, "hover:/a.ts", {
				ledgerKind: "lsp-nav-request-timeout",
				risingEdgePer: "identity",
				reason: "timeout",
			});
			expect([first, second]).toEqual([true, false]);
			// The batching caller (#1705) writes its own single record.
			expect(boundedPhaseCalls()).toHaveLength(0);
			expect(summaryFor("lsp-nav-request-timeout")?.count).toBe(2);
		});
	});

	describe("contract", () => {
		it("never throws, whatever the payload holds", () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			expect(() =>
				emitBounded("loop_block", "<pi-lens>", {
					durationMs: 1,
					metadata: circular,
				}),
			).not.toThrow();
		});

		it("keeps the registry free of duplicates", () => {
			expect(new Set(BOUNDED_TELEMETRY_PHASES).size).toBe(
				BOUNDED_TELEMETRY_PHASES.length,
			);
		});
	});
});
