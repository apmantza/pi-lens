/**
 * #3813 — one-shot state a producer consumes while `handleTurnEnd` composes
 * the message must not be consumed for text `capTurnEndMessage` cut.
 *
 * Recurrence (PR #3776 verify V1, found while building the C1 fixture): four
 * past-EOF demoted records were retired "after this ONE delivery" inside the
 * per-record loop, before the cap ran; the delivered message showed two of
 * them and ended `... (truncated)`, so the other two were retired unseen and
 * never served again. The same shape rides every producer that drains or
 * counts before the cap: the dependency-drift delivery count, the cascade
 * runs, the late runner findings, the late auxiliary coverage pairs, and a
 * resolved retirement the signature dedupe suppresses (#3776 verify r3 F6).
 *
 * Every test drives the REAL `handleTurnEnd` and reads the delivered message
 * the way production does (`consumeTurnEndFindings`), then asserts the
 * producer's own state and the NEXT turn's message. The cap is never mocked.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const readCachedDiagnosticsForServers = vi.hoisted(() => vi.fn());
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	// The process boundary: a real auxiliary client is an external child
	// process. The double carries the full service surface (#2582).
	getLSPService: () =>
		makeLspServiceDouble({
			readCachedDiagnosticsForServers,
			observeLateAuxiliaryAnswer: async () => undefined,
		}),
}));

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	// Spied AND passed through: the real sink still runs.
	return {
		...actual,
		logLatency: (entry: Parameters<typeof actual.logLatency>[0]) => {
			logLatency(entry);
			actual.logLatency(entry);
		},
	};
});

import { CacheManager } from "../../clients/cache-manager.js";
import { resetBoundedTelemetry } from "../../clients/bounded-telemetry.js";
import type { CascadeResult } from "../../clients/cascade-types.js";
import { _resetSharedLineCountCacheForTests } from "../../clients/diagnostic-line-freshness.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	deferRunnerFindings,
	pendingRunnerFindingsSize,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	markPendingAuxiliaryCoverage,
	MAX_LATE_AUX_REARMS,
	pendingAuxiliaryCoverageSize,
	resetPendingAuxiliaryCoverage,
} from "../../clients/lsp/pending-aux-coverage.js";
import { DEPENDENCY_DRIFT_MAX_DELIVERIES } from "../../clients/blocker-freshness.js";
import {
	_resetStateCacheForTests,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import { evaluateGitGuard } from "../../clients/git-guard.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { beginScope, retireScope } from "../../clients/session-scope.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const SESSION = "session-3813";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	midTurn?: () => void,
	lensGuard = false,
) {
	return {
		ctxCwd: cwd,
		getFlag: (name: string) => lensGuard && name === "lens-guard",
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			// A real await inside the composer, where a test can change the world.
			analyze: async () => {
				midTurn?.();
				return EMPTY_KNIP_RESULT;
			},
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

interface Rig {
	cwd: string;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	/** `--lens-guard`: the flag the commit gate hangs off. */
	lensGuard: boolean;
	cleanup: () => void;
}

function makeRig(prefix: string): Rig {
	const env = setupTestEnvironment(prefix);
	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: SESSION });
	runtime.beginTurn();
	return {
		cwd: env.tmpDir,
		runtime,
		cacheManager: new CacheManager(false),
		lensGuard: false,
		cleanup: env.cleanup,
	};
}

/** Mark a file edited this turn so turn_end takes its main path. */
function touch(rig: Rig, name: string, content = "export const a = 1;\n") {
	const file = path.join(rig.cwd, name);
	fs.writeFileSync(file, content);
	rig.runtime.bumpFileSeq(file);
	rig.cacheManager.addModifiedRange(
		file,
		{ start: 1, end: 1 },
		false,
		rig.cwd,
		SESSION,
	);
	return file;
}

/** End the turn; return what the agent receives, consumed like production. */
async function endTurn(rig: Rig, midTurn?: () => void): Promise<string> {
	await handleTurnEnd(
		makeDeps(rig.runtime, rig.cacheManager, rig.cwd, midTurn, rig.lensGuard),
	);
	return (
		consumeTurnEndFindings(rig.cacheManager, rig.cwd, rig.runtime)
			?.messages?.[0]?.content ?? ""
	);
}

/** Start the next turn with a fresh edit (and a noise file so the signature
 *  dedupe never hides a re-offer behind byte-identical text). */
function nextTurn(rig: Rig, turn: number): void {
	rig.runtime.beginTurn();
	touch(rig, `noise-${turn}.ts`, `export const n${turn} = ${turn};\n`);
}

/**
 * A live blocker whose "Unresolved from this turn" part is EXACTLY `chars`
 * long, so the parts after it start at `chars + 2` and the cell a later part
 * lands in (fits / partially cut / fully cut) is arithmetic, not luck. The cap
 * keeps 1000 chars and 20 lines; lines are long so the char axis cuts first.
 */
function fillerBlocker(rig: Rig, chars: number): string {
	const file = touch(rig, "filler.ts");
	const prefix = "Unresolved from this turn — filler.ts:\n";
	const header = "🔴 STOP — filler blocker";
	const lines: string[] = [];
	let remaining = chars - prefix.length - header.length;
	while (remaining > 1) {
		const n = Math.min(100, remaining - 1);
		lines.push("x".repeat(n));
		remaining -= n + 1;
	}
	const summary = [header + "x".repeat(Math.max(0, remaining)), ...lines].join(
		"\n",
	);
	expect(prefix.length + summary.length).toBe(chars);
	rig.runtime.recordInlineBlockers(
		file,
		summary,
		rig.runtime.nextWriteIndex(),
		["eslint"],
		[1],
	);
	return file;
}

/** Retire the filler so the next turn has room. */
function clearFiller(rig: Rig, file: string): void {
	rig.runtime.clearInlineBlockers(file, rig.runtime.nextWriteIndex());
}

function ledgerCount(kind: string): number {
	return getDegradationSummary()
		.filter((entry) => entry.kind === kind)
		.reduce((sum, entry) => sum + entry.count, 0);
}

beforeEach(() => {
	_resetStateCacheForTests();
	resetDegradationLedger();
	resetBoundedTelemetry();
	resetPendingRunnerFindings();
	resetPendingAuxiliaryCoverage();
	readCachedDiagnosticsForServers.mockReset();
	_resetSharedLineCountCacheForTests();
});

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
	resetDegradationLedger();
	resetBoundedTelemetry();
	resetPendingRunnerFindings();
	resetPendingAuxiliaryCoverage();
});

/**
 * Where a part lands relative to the cap. `filler` is the length of the live
 * blocker part riding before it; the next part starts at `filler + 2` and the
 * cap keeps 1000 chars. Every fixture part below is 250-600 chars long, so
 * 300 fits it whole, 880 cuts it mid-text and 1000 cuts it away entirely.
 */
const CELLS = [
	{ cell: "fits", filler: 300, reached: true },
	{ cell: "partially cut", filler: 880, reached: false },
	{ cell: "fully cut", filler: 1000, reached: false },
] as const;

const PAD = "z".repeat(220);

/** A past-EOF demoted record: cites line 999 of a one-line file. */
function pastEofRecord(rig: Rig, name: string, pad = PAD): string {
	const file = touch(rig, name);
	rig.runtime.recordInlineBlockers(
		file,
		`🔴 L999 ${name} cited past EOF ${pad}`,
		rig.runtime.nextWriteIndex(),
		["eslint"],
		[999],
	);
	return file;
}

function pending(rig: Rig, file: string): boolean {
	return rig.runtime
		.getInlineBlockersSnapshot()
		.some((record) => record.filePath === file);
}

const RETIRED_NOTE = "Retired after this delivery";

describe("M1: past-EOF retirement vs the cap (#3813)", () => {
	// Recurrence: #3776 C1 fixture. Four records, two shown, all four retired.
	it.each(CELLS)(
		"$cell: retires only a record whose whole advisory reached the message",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3813-m1-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				const file = pastEofRecord(rig, "pe-a.ts");

				const first = await endTurn(rig);
				expect(first.includes(RETIRED_NOTE)).toBe(reached);
				expect(first.includes("(truncated")).toBe(!reached);
				expect(pending(rig, file)).toBe(!reached);

				if (!reached) {
					// Re-offered on the next turn, whole this time, then retired.
					clearFiller(rig, fillerFile);
					nextTurn(rig, 2);
					const second = await endTurn(rig);
					expect(second).toContain(RETIRED_NOTE);
					expect(second).toContain("pe-a.ts");
					expect(pending(rig, file)).toBe(false);
				}
			} finally {
				rig.cleanup();
			}
		},
	);

	// The cap cuts on lines too (20): a record that fits the char budget but
	// starts past line 20 was cut. Recurrence guard for the kept-length axis.
	it("holds a record the 20-line axis cut though the char budget had room", async () => {
		const rig = makeRig("pi-lens-3813-m1-lines-");
		try {
			const fillerFile = touch(rig, "filler.ts");
			// 19 short lines: ~100 chars, far under the char axis.
			rig.runtime.recordInlineBlockers(
				fillerFile,
				Array.from({ length: 18 }, (_, i) => `L${i}`).join("\n"),
				rig.runtime.nextWriteIndex(),
				["eslint"],
				[1],
			);
			const file = pastEofRecord(rig, "pe-a.ts", "z");
			const first = await endTurn(rig);
			expect(first).toContain("(truncated");
			expect(first).not.toContain(RETIRED_NOTE);
			expect(pending(rig, file)).toBe(true);
		} finally {
			rig.cleanup();
		}
	});

	it("holds each of four cut records for the next turn, not just the ones the agent never saw named", async () => {
		const rig = makeRig("pi-lens-3813-m1-four-");
		try {
			const fillerFile = fillerBlocker(rig, 330);
			const names = ["pe-a.ts", "pe-b.ts", "pe-c.ts", "pe-d.ts"];
			const files = names.map((name) =>
				pastEofRecord(rig, name, "z".repeat(60)),
			);
			const first = await endTurn(rig);
			const wholeShown = names.filter((name) =>
				first.includes(
					`${name} cited past EOF ${"z".repeat(60)}\n${RETIRED_NOTE}`,
				),
			);
			expect(wholeShown.length).toBeGreaterThan(0);
			expect(wholeShown.length).toBeLessThan(names.length);
			const held = names.filter((name) => !wholeShown.includes(name));
			expect(
				files.filter((file) => pending(rig, file)).map((f) => path.basename(f)),
			).toEqual(held);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			const second = await endTurn(rig);
			for (const name of held) expect(second).toContain(name);
			expect(files.some((file) => pending(rig, file))).toBe(false);
		} finally {
			rig.cleanup();
		}
	});

	// Guard for the floor, not a regression: an advisory too big for the cap
	// even as the first part can never "fit"; holding it would pin it forever.
	// It passes on the pre-fix code by design.
	it("retires a record whose advisory cannot fit the cap even alone (no starvation)", async () => {
		const rig = makeRig("pi-lens-3813-m1-oversize-");
		try {
			const file = pastEofRecord(
				rig,
				"pe-big.ts",
				Array.from({ length: 30 }, (_, i) => `L${i} ${"q".repeat(40)}`).join(
					"\n",
				),
			);
			const first = await endTurn(rig);
			expect(first).toContain("(truncated");
			expect(first).toContain("pe-big.ts");
			expect(pending(rig, file)).toBe(false);
		} finally {
			rig.cleanup();
		}
	});
});

describe("one bounded record and a held note (#3813)", () => {
	it("records ONE counted row per turn however many sections it held, and says so in the message", async () => {
		const rig = makeRig("pi-lens-3813-record-");
		try {
			fillerBlocker(rig, 1000);
			for (const name of ["pe-a.ts", "pe-b.ts", "pe-c.ts"])
				pastEofRecord(rig, name);

			const first = await endTurn(rig);
			expect(first).toContain("... (truncated; 3 held for the next turn)");
			expect(ledgerCount("turn-end-sections-held")).toBe(1);
			const row = logLatency.mock.calls
				.map((call) => call[0])
				.find(
					(entry: any) =>
						entry?.type === "tool_result" && entry?.toolName === "turn_end",
				);
			expect(row.metadata.heldSections).toBe(3);
		} finally {
			rig.cleanup();
		}
	});

	it("a turn that holds nothing writes no row and no note", async () => {
		const rig = makeRig("pi-lens-3813-record-none-");
		try {
			fillerBlocker(rig, 300);
			pastEofRecord(rig, "pe-a.ts");
			const first = await endTurn(rig);
			expect(first).not.toContain("held for the next turn");
			expect(ledgerCount("turn-end-sections-held")).toBe(0);
		} finally {
			rig.cleanup();
		}
	});
});

/** A record the freshness gate demoted for dependency drift. */
function driftRecord(rig: Rig, name: string): string {
	const file = touch(rig, name);
	rig.runtime.recordInlineBlockers(
		file,
		`🔴 L1 ${name} a real blocker ${PAD}`,
		rig.runtime.nextWriteIndex(),
		["eslint"],
		[1],
	);
	rig.runtime.markInlineBlockerStale(file, "dependency-drift");
	return file;
}

describe("M2: dependency-drift delivery count vs the cap (#3813)", () => {
	// Recurrence: a cut delivery was counted, so the record retired at
	// DEPENDENCY_DRIFT_MAX_DELIVERIES with fewer real deliveries.
	it.each(CELLS)(
		"$cell: counts a delivery only when the whole advisory reached the message",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3813-m2-");
			try {
				fillerBlocker(rig, filler);
				const file = driftRecord(rig, "drift-a.ts");
				await endTurn(rig);
				expect(rig.runtime.peekInlineBlockerStaleDeliveryCount(file)).toBe(
					reached ? 1 : 0,
				);
			} finally {
				rig.cleanup();
			}
		},
	);

	it("a cut delivery does not retire the record at the cap; the next whole one does", async () => {
		const rig = makeRig("pi-lens-3813-m2-cap-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			const file = driftRecord(rig, "drift-a.ts");
			for (let i = 0; i < DEPENDENCY_DRIFT_MAX_DELIVERIES - 1; i++)
				rig.runtime.incrementInlineBlockerStaleDelivery(file);

			await endTurn(rig);
			expect(pending(rig, file)).toBe(true);
			expect(ledgerCount("demoted-finding-retired")).toBe(0);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			const second = await endTurn(rig);
			expect(second).toContain("drift-a.ts");
			expect(pending(rig, file)).toBe(false);
			expect(ledgerCount("demoted-finding-retired")).toBe(1);
		} finally {
			rig.cleanup();
		}
	});
});

function cascadeResult(primary: string, neighbor: string, text: string) {
	const diagnostic: Diagnostic = {
		id: "lsp:test:1",
		message: "cascade message",
		filePath: neighbor,
		line: 1,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: "cascade:test",
	};
	const result: CascadeResult = {
		filePath: primary,
		impact: {
			filePath: primary,
			changedSymbols: [],
			directImporters: [neighbor],
			directCallers: [],
			neighborFiles: [neighbor],
			riskFlags: [],
		},
		neighbors: [
			{
				filePath: neighbor,
				reason: "imports",
				diagnostics: [diagnostic],
				lspTouched: false,
			},
		],
		formatted: `Cascade errors in 1 dependent file\n${path.basename(neighbor)}: ${text}`,
	};
	return result;
}

const CASCADE_END = "ENDCASC";

describe("M3a: cascade runs vs the cap (#3813)", () => {
	// Recurrence: `consumeCascadeRuns` drains every run before the cap runs.
	it.each(CELLS)(
		"$cell: a run is consumed only when its whole section reached the message",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3813-m3a-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				const primary = touch(rig, "casc-primary.ts");
				const neighbor = touch(rig, "casc-dep.ts");
				rig.runtime.appendCascadeRun({
					filePath: primary,
					result: cascadeResult(primary, neighbor, `${PAD}${CASCADE_END}`),
					neighborCount: 1,
					diagnosticCount: 1,
				});

				const first = await endTurn(rig);
				expect(first.includes(CASCADE_END)).toBe(reached);
				expect(rig.runtime.hasCascadeRuns()).toBe(!reached);

				if (!reached) {
					clearFiller(rig, fillerFile);
					nextTurn(rig, 2);
					const second = await endTurn(rig);
					expect(second).toContain(CASCADE_END);
					expect(rig.runtime.hasCascadeRuns()).toBe(false);
				}
			} finally {
				rig.cleanup();
			}
		},
	);

	// Recurrence guard for the new restore: it runs after awaits that can
	// outlive the session, so a replaced session must not receive the old
	// session's run (the shape #3512 closed for the cascade admission).
	it("does not hand a cut run back to a session that replaced the one it came from", async () => {
		const rig = makeRig("pi-lens-3813-m3a-session-");
		try {
			fillerBlocker(rig, 1000);
			const primary = touch(rig, "casc-primary.ts");
			const neighbor = touch(rig, "casc-dep.ts");
			rig.runtime.appendCascadeRun({
				filePath: primary,
				result: cascadeResult(primary, neighbor, `${PAD}${CASCADE_END}`),
				neighborCount: 1,
				diagnosticCount: 1,
			});
			await endTurn(rig, () => rig.runtime.resetForSession());
			expect(rig.runtime.hasCascadeRuns()).toBe(false);
		} finally {
			rig.cleanup();
		}
	});

	// A run feeding both the section and a coverage advisory: the advisory is
	// cut, the section fit. Only the advisory comes back; re-delivering the
	// section would show the agent the same blocker twice.
	it("re-offers only the cut coverage advisory of a run whose section was delivered", async () => {
		const rig = makeRig("pi-lens-3813-m3a-halves-");
		try {
			fillerBlocker(rig, 600);
			const primary = touch(rig, "casc-primary.ts");
			const neighbor = touch(rig, "casc-dep.ts");
			rig.runtime.appendCascadeRun({
				filePath: primary,
				result: cascadeResult(primary, neighbor, `${PAD}${CASCADE_END}`),
				neighborCount: 1,
				diagnosticCount: 1,
				indeterminate: {
					reason: "budget_truncated",
					detail: "cascade budget exhausted ENDBUD",
				},
			});
			const first = await endTurn(rig);
			expect(first).toContain(CASCADE_END);
			expect(first).not.toContain("ENDBUD");

			nextTurn(rig, 2);
			const second = await endTurn(rig);
			expect(second).toContain("ENDBUD");
			expect(second).not.toContain(CASCADE_END);
		} finally {
			rig.cleanup();
		}
	});

	// Pins the EXISTING one-turn carry bound (#1443): a run cut twice is
	// dropped by `beginTurn`, with its `cascade_carry_over_drop` record, never
	// replayed forever behind a persistent blocker.
	it("a run cut on two consecutive turns hits the carry bound instead of re-serving forever", async () => {
		const rig = makeRig("pi-lens-3813-m3a-bound-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			const primary = touch(rig, "casc-primary.ts");
			const neighbor = touch(rig, "casc-dep.ts");
			rig.runtime.appendCascadeRun({
				filePath: primary,
				result: cascadeResult(primary, neighbor, `${PAD}${CASCADE_END}`),
				neighborCount: 1,
				diagnosticCount: 1,
			});
			await endTurn(rig);
			nextTurn(rig, 2);
			const second = await endTurn(rig);
			expect(second).not.toContain(CASCADE_END);
			expect(rig.runtime.hasCascadeRuns()).toBe(true);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 3);
			const third = await endTurn(rig);
			expect(third).not.toContain(CASCADE_END);
			expect(rig.runtime.hasCascadeRuns()).toBe(false);
		} finally {
			rig.cleanup();
		}
	});
});

const INDETERMINATE_END = "graph unavailable ENDIND: ind-primary.ts";

describe("M3b: cascade coverage advisories vs the cap (#3813)", () => {
	it.each(CELLS)(
		"$cell: an indeterminate run is consumed only when its advisory reached the message",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3813-m3b-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				const primary = touch(rig, "ind-primary.ts");
				rig.runtime.appendCascadeRun({
					filePath: primary,
					result: undefined,
					neighborCount: 0,
					diagnosticCount: 0,
					skipReason: "indeterminate",
					indeterminate: {
						reason: "graph_degraded",
						detail: `graph unavailable ENDIND`,
					},
				});

				const first = await endTurn(rig);
				expect(first.includes(INDETERMINATE_END)).toBe(reached);
				expect(rig.runtime.hasCascadeRuns()).toBe(!reached);

				if (!reached) {
					clearFiller(rig, fillerFile);
					nextTurn(rig, 2);
					expect(await endTurn(rig)).toContain(INDETERMINATE_END);
				}
			} finally {
				rig.cleanup();
			}
		},
	);
});

const RUNNER_END = "ENDRUN";

function runnerDiagnostic(file: string, message: string): Diagnostic {
	return {
		id: "rf1",
		message,
		filePath: file,
		line: 1,
		column: 1,
		severity: "warning",
		semantic: "warning",
		tool: "slow-runner",
		rule: "r1",
	};
}

/** Defer a settled runner result for a file whose mtime predates the mark. */
function deferSettled(
	rig: Rig,
	name: string,
	result: Parameters<typeof deferRunnerFindings>[0]["promise"] extends Promise<
		infer R
	>
		? R
		: never,
): string {
	const file = touch(rig, name);
	const past = new Date(Date.now() - 10_000);
	fs.utimesSync(file, past, past);
	deferRunnerFindings({
		filePath: file,
		cwd: rig.cwd,
		projectRoot: rig.cwd,
		runnerId: "slow-runner",
		markedAtMs: Date.now(),
		promise: Promise.resolve(result),
	});
	return file;
}

describe("M3c: late runner findings vs the cap (#3813)", () => {
	// Recurrence: `drainPendingRunnerFindings` removes a settled entry for good.
	it.each(CELLS)(
		"$cell: a settled result is consumed only when its whole part reached the message",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3813-m3c-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				const file = path.join(rig.cwd, "run-a.ts");
				deferSettled(rig, "run-a.ts", {
					status: "succeeded",
					semantic: "warning",
					diagnostics: [runnerDiagnostic(file, `${PAD}${RUNNER_END}`)],
				});

				const first = await endTurn(rig);
				expect(first.includes(RUNNER_END)).toBe(reached);
				expect(pendingRunnerFindingsSize()).toBe(reached ? 0 : 1);

				if (!reached) {
					clearFiller(rig, fillerFile);
					nextTurn(rig, 2);
					expect(await endTurn(rig)).toContain(RUNNER_END);
					expect(pendingRunnerFindingsSize()).toBe(0);
				}
			} finally {
				rig.cleanup();
			}
		},
	);

	it("a cut broken-runner note is re-offered", async () => {
		const rig = makeRig("pi-lens-3813-m3c-failed-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			deferSettled(rig, "run-a.ts", {
				status: "failed",
				semantic: "warning",
				diagnostics: [],
				failureKind: "timeout",
				failureMessage: `${PAD}ENDFAIL`,
			});
			expect(await endTurn(rig)).not.toContain("ENDFAIL");
			expect(pendingRunnerFindingsSize()).toBe(1);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			expect(await endTurn(rig)).toContain("ENDFAIL");
		} finally {
			rig.cleanup();
		}
	});

	it("an entry whose note fit and findings were cut re-offers only the findings", async () => {
		const rig = makeRig("pi-lens-3813-m3c-split-");
		try {
			// The broken-runner note is ~100 chars and fits; the findings do not.
			const fillerFile = fillerBlocker(rig, 760);
			const file = path.join(rig.cwd, "run-a.ts");
			deferSettled(rig, "run-a.ts", {
				status: "failed",
				semantic: "warning",
				failureKind: "timeout",
				failureMessage: "boom",
				diagnostics: [runnerDiagnostic(file, `${PAD}${RUNNER_END}`)],
			});
			const first = await endTurn(rig);
			expect(first).toContain("Deferred runner slow-runner failed");
			expect(first).not.toContain(RUNNER_END);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			const second = await endTurn(rig);
			expect(second).toContain(RUNNER_END);
			expect(second).not.toContain("Deferred runner slow-runner failed");
		} finally {
			rig.cleanup();
		}
	});
	// #3796 item 3. Recurrence prevented: the requeued findings kept `failed`
	// but lost the kind, so once a kindless `failed` read as broken the next
	// turn end announced a runner failure that never happened.
	it("re-offers a cut findings-failed entry's findings without a broken-runner note", async () => {
		const rig = makeRig("pi-lens-3813-m3c-findings-failed-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			const file = path.join(rig.cwd, "run-a.ts");
			deferSettled(rig, "run-a.ts", {
				status: "failed",
				semantic: "warning",
				failureKind: "blocking_diagnostics",
				diagnostics: [runnerDiagnostic(file, `${PAD}${RUNNER_END}`)],
			});
			const first = await endTurn(rig);
			expect(first).not.toContain(RUNNER_END);
			expect(pendingRunnerFindingsSize()).toBe(1);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			const second = await endTurn(rig);
			expect(second).toContain(RUNNER_END);
			expect(second).not.toContain("Deferred runner slow-runner failed");
		} finally {
			rig.cleanup();
		}
	});

	it("re-offers a failed entry's note and findings once each when both were cut", async () => {
		const rig = makeRig("pi-lens-3813-m3c-both-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			const file = path.join(rig.cwd, "run-a.ts");
			deferSettled(rig, "run-a.ts", {
				status: "failed",
				semantic: "warning",
				failureKind: "timeout",
				failureMessage: "boom",
				diagnostics: [runnerDiagnostic(file, `${PAD}${RUNNER_END}`)],
			});
			await endTurn(rig);
			expect(pendingRunnerFindingsSize()).toBe(2);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			const second = await endTurn(rig);
			expect(second.split(RUNNER_END)).toHaveLength(2);
			expect(second.split("Deferred runner slow-runner failed")).toHaveLength(
				2,
			);
		} finally {
			rig.cleanup();
		}
	});

	// The stale half of a result is dropped, and recorded, when it is drained.
	// A cut part hands back only the live half so the drop is not recorded
	// again on the next drain.
	it("does not record a result's stale findings a second time when the live part was cut", async () => {
		const rig = makeRig("pi-lens-3813-m3c-stale-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			const live = touch(rig, "run-live.ts");
			const past = new Date(Date.now() - 10_000);
			fs.utimesSync(live, past, past);
			// Marked now; the second file is edited AFTER the mark, so its
			// finding is stale at the freshness gate.
			const drifted = touch(rig, "run-drifted.ts");
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(drifted, future, future);
			deferRunnerFindings({
				filePath: live,
				cwd: rig.cwd,
				projectRoot: rig.cwd,
				runnerId: "slow-runner",
				markedAtMs: Date.now(),
				promise: Promise.resolve({
					status: "succeeded",
					semantic: "warning",
					diagnostics: [
						runnerDiagnostic(live, `${PAD}${RUNNER_END}`),
						{ ...runnerDiagnostic(drifted, "drifted"), id: "rf2" },
					],
				}),
			});
			await endTurn(rig);
			expect(ledgerCount("runner-findings-stale")).toBe(1);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			expect(await endTurn(rig)).toContain(RUNNER_END);
			expect(ledgerCount("runner-findings-stale")).toBe(1);
		} finally {
			rig.cleanup();
		}
	});

	// Guard for the suppressed arm, not a regression: an identical message the
	// agent already holds still settles what fit in it (that IS delivered
	// text), so the result is not queued again to re-offer an identical
	// message forever. Passes on the pre-fix code by design.
	it("a dedupe-suppressed identical turn still consumes a fitting result", async () => {
		const rig = makeRig("pi-lens-3813-m3c-dedupe-");
		try {
			const run = () => {
				const file = path.join(rig.cwd, "run-a.ts");
				deferSettled(rig, "run-a.ts", {
					status: "succeeded",
					semantic: "warning",
					diagnostics: [runnerDiagnostic(file, `stable ${RUNNER_END}`)],
				});
			};
			run();
			expect(await endTurn(rig)).toContain(RUNNER_END);

			rig.runtime.beginTurn();
			run();
			expect(await endTurn(rig)).toBe("");
			expect(pendingRunnerFindingsSize()).toBe(0);
		} finally {
			rig.cleanup();
		}
	});

	// #3824 S3: the session-carry requeue through the REAL production trigger.
	// The unit replay in runner-collect-later.test.ts calls drain/requeue
	// directly; this drives the cap cut, the delivery hold's `onHeld` requeue
	// and the successor's own `handleTurnEnd`, so the scope fence is proven at
	// the entry point production uses, not a parallel helper.
	it("drops a requeued result at a successor scope's turn end after its owner retired (#3758/#3813)", async () => {
		const rig = makeRig("pi-lens-3813-m3c-scope-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			const file = touch(rig, "run-scope.ts");
			const past = new Date(Date.now() - 10_000);
			fs.utimesSync(file, past, past);
			// The producer's captured handle, taken before its work settled.
			const handle = rig.runtime.captureSessionGeneration();
			deferRunnerFindings({
				filePath: file,
				cwd: rig.cwd,
				projectRoot: rig.cwd,
				runnerId: "slow-runner",
				markedAtMs: Date.now(),
				promise: Promise.resolve({
					status: "succeeded",
					semantic: "warning",
					diagnostics: [runnerDiagnostic(file, `${PAD}${RUNNER_END}`)],
				}),
				session: handle,
			});

			// The cap cut the part; the hold handed the settled result back.
			expect(await endTurn(rig)).not.toContain(RUNNER_END);
			expect(pendingRunnerFindingsSize()).toBe(1);
			clearFiller(rig, fillerFile);
			// `/new` retires the scope before the next session_start clears the
			// store. The successor's turn end drains an entry whose handle has
			// retired, so it must be dropped with its counted row, not delivered.
			rig.runtime.resetForSession();
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain(RUNNER_END);
			expect(pendingRunnerFindingsSize()).toBe(0);
			expect(ledgerCount("generation-guard-stale-write")).toBeGreaterThan(0);
		} finally {
			rig.cleanup();
		}
	});
});

const AUX_END = "ENDAUX";

function auxDiag(line: number, message: string) {
	return {
		range: {
			start: { line, character: 0 },
			end: { line, character: 10 },
		},
		severity: 2,
		code: "rule-x",
		source: "opengrep",
		message,
	};
}

function markAux(rig: Rig, name: string): string {
	const file = touch(rig, name);
	const past = new Date(Date.now() - 10_000);
	fs.utimesSync(file, past, past);
	markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 2000);
	readCachedDiagnosticsForServers.mockImplementation(
		async () =>
			new Map([
				[
					"opengrep",
					{
						diags: [auxDiag(0, `${PAD}${AUX_END}`)],
						publishedAt: Date.now(),
					},
				],
			]),
	);
	return file;
}

describe("M3d: late auxiliary coverage vs the cap (#3813)", () => {
	// Recurrence: `drainPendingAuxiliaryCoverage` clears the whole store.
	it.each(CELLS)(
		"$cell: a pair is consumed only when its whole part reached the message",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3813-m3d-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				markAux(rig, "aux-a.ts");

				const first = await endTurn(rig);
				expect(first.includes(AUX_END)).toBe(reached);
				expect(pendingAuxiliaryCoverageSize()).toBe(reached ? 0 : 1);

				if (!reached) {
					clearFiller(rig, fillerFile);
					nextTurn(rig, 2);
					expect(await endTurn(rig)).toContain(AUX_END);
					expect(pendingAuxiliaryCoverageSize()).toBe(0);
				}
			} finally {
				rig.cleanup();
			}
		},
	);

	// The re-offer honours the pair's re-arm TTL too: a pair past it is not
	// kept alive by the cap.
	it("does not re-arm a cut pair that is past its re-arm TTL", async () => {
		process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "1";
		try {
			const rig = makeRig("pi-lens-3813-m3d-ttl-");
			try {
				fillerBlocker(rig, 1000);
				// Marked two seconds ago, so one millisecond of TTL is long past.
				markAux(rig, "aux-a.ts");
				await endTurn(rig);
				expect(pendingAuxiliaryCoverageSize()).toBe(0);
			} finally {
				rig.cleanup();
			}
		} finally {
			delete process.env.PI_LENS_LATE_AUX_REARM_TTL_MS;
		}
	});

	// The re-offer spends the pair's own re-arm ceiling, so a blocker that
	// never clears cannot keep a pair alive forever. r1 F3: the drop at the
	// ceiling is not a hold (the message must not promise it), and it writes
	// its own record.
	it("a pair cut on every turn stops re-arming at the ceiling and records the drop", async () => {
		const rig = makeRig("pi-lens-3813-m3d-bound-");
		try {
			fillerBlocker(rig, 1000);
			markAux(rig, "aux-a.ts");
			const messages: string[] = [];
			let turns = 0;
			while (pendingAuxiliaryCoverageSize() > 0 && turns < 20) {
				turns += 1;
				nextTurn(rig, turns);
				const message = await endTurn(rig);
				if (message) messages.push(message);
			}
			expect(pendingAuxiliaryCoverageSize()).toBe(0);
			// Held (kept pending) on each turn that re-armed the pair; the
			// turn that found it past the ceiling dropped it instead.
			// (A turn the cycle cap skips outright drains nothing.)
			expect(ledgerCount("turn-end-sections-held")).toBe(MAX_LATE_AUX_REARMS);
			expect(ledgerCount("late-auxiliary-held-dropped")).toBe(1);
			const last = messages[messages.length - 1] ?? "";
			expect(last).toContain("(truncated");
			expect(last).not.toContain("held for the next turn");
		} finally {
			rig.cleanup();
		}
	});

	// r1 F3: the row that says what a turn did with its pairs is written
	// before the cap runs, so a re-arm made by a hold needs its own row, or
	// `pendingAfter` reads 0 for a pair that is still pending.
	it("logs the hold's re-arm and the store size after it settles", async () => {
		const rig = makeRig("pi-lens-3813-m3d-row-");
		try {
			fillerBlocker(rig, 1000);
			markAux(rig, "aux-a.ts");
			await endTurn(rig);
			const row = logLatency.mock.calls
				.map((call) => call[0])
				.find((entry: any) => entry?.phase === "late_auxiliary_holds");
			expect(row?.metadata).toMatchObject({ rearmed: 1, pendingAfter: 1 });
		} finally {
			rig.cleanup();
		}
	});
});

/**
 * #4161: `handleTurnEnd` captured its session at entry and drained the hold
 * stores after several awaits. A session replaced inside that window (`/new`,
 * a resume) left the old turn draining the NEW session's state; settle then
 * skipped the restore for the stale session, so a cut item was gone. Every
 * case replaces the session between the turn's entry and a drain, then asks
 * the successor's own stores and its next turn.
 */
describe("#4161: a turn whose session was replaced drains nothing of its successor's", () => {
	const SUCCESSOR = "session-4161-successor";
	const runEnd = (name: string) => `${PAD}END-${name}`;

	function cascadeRun(rig: Rig, name: string) {
		const primary = touch(rig, `${name}.ts`);
		const neighbor = touch(rig, `${name}-dep.ts`);
		return {
			filePath: primary,
			result: cascadeResult(primary, neighbor, runEnd(name)),
			neighborCount: 1,
			diagnosticCount: 1,
		};
	}

	/** The successor's `session_start` reset plus its own identity. */
	function replace(rig: Rig): void {
		rig.runtime.resetForSession();
		rig.runtime.setTelemetryIdentity({ sessionId: SUCCESSOR });
	}

	function staleWriteSubjects(): string[] {
		return getDegradationSummary()
			.filter((entry) => entry.kind === "generation-guard-stale-write")
			.flatMap((entry) => entry.latestReasons.map((r) => r.subject));
	}

	/** The drain's one `late_auxiliary_findings` row for the turn. */
	function lateAuxRow(): any {
		return logLatency.mock.calls
			.map((call) => call[0])
			.find((entry: any) => entry?.phase === "late_auxiliary_findings");
	}

	// Recurrence: REVIEW_4155 F1. The replacement lands at the turn's first
	// await; the successor records a blocker that cuts every later part, a
	// built cascade run, and a compute still parked for the settle.
	it("leaves the successor's cascade run and parked compute for the successor's own turn", async () => {
		const rig = makeRig("pi-lens-4161-cascade-");
		try {
			touch(rig, "old-edit.ts");
			let successorFiller = "";
			queueMicrotask(() => {
				replace(rig);
				successorFiller = fillerBlocker(rig, 1000);
				rig.runtime.appendCascadeRun(cascadeRun(rig, "succ-built"));
				rig.runtime.appendCascadePromise(
					Promise.resolve(cascadeRun(rig, "succ-pending")),
					rig.runtime.captureSessionGeneration(),
					path.join(rig.cwd, "succ-pending.ts"),
				);
			});
			await endTurn(rig);

			clearFiller(rig, successorFiller);
			nextTurn(rig, 2);
			const successorTurn = await endTurn(rig);
			expect(successorTurn).toContain("END-succ-built");
			expect(successorTurn).toContain("END-succ-pending");
			expect(staleWriteSubjects()).toEqual(
				expect.arrayContaining([
					"runtime-session:cascade-settle",
					"runtime-session:turn-end:cascade-runs",
				]),
			);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence: REVIEW_4155 F1, the reviewer's window. The replacement lands
	// inside the cascade settle's await: the old session's compute settles
	// there, and the successor appends its own run.
	it("keeps the successor's run and drops the replaced session's compute that settles inside the settle wait", async () => {
		const rig = makeRig("pi-lens-4161-settle-");
		try {
			fillerBlocker(rig, 1000);
			const oldRun = cascadeRun(rig, "old-pending");
			const settled = Promise.resolve(oldRun);
			// `settleCascadeRuns` attaches the first `.then` when it takes the
			// compute; the hook replaces the session in the next microtask, while
			// the settle awaits.
			const then = settled.then.bind(settled);
			let taken = false;
			(settled as any).then = (onFulfilled: any, onRejected: any) => {
				if (!taken) {
					taken = true;
					queueMicrotask(() => {
						replace(rig);
						rig.runtime.appendCascadeRun(cascadeRun(rig, "succ-built"));
					});
				}
				return then(onFulfilled, onRejected);
			};
			rig.runtime.appendCascadePromise(
				settled,
				rig.runtime.captureSessionGeneration(),
				oldRun.filePath,
			);
			await endTurn(rig);
			expect(taken).toBe(true);

			const pendingAfter = rig.runtime
				.consumeCascadeRuns()
				.map((run) => path.basename(run.filePath));
			expect(pendingAfter).toEqual(["succ-built.ts"]);
			expect(staleWriteSubjects()).toEqual(
				expect.arrayContaining([
					"runtime-session:turn-end:cascade-runs",
					`runtime-session:${oldRun.filePath}`,
				]),
			);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence: the late-auxiliary drain sits after every scan await. The
	// replacement lands in the knip scan, after the old turn read its blocker
	// (which cuts the part), and the successor marks its own pair.
	it("leaves the successor's late-auxiliary pair pending", async () => {
		const rig = makeRig("pi-lens-4161-aux-drain-");
		try {
			fillerBlocker(rig, 1000);
			touch(rig, "old-edit.ts");
			await endTurn(rig, () => {
				replace(rig);
				markAux(rig, "succ-aux.ts");
			});
			expect(pendingAuxiliaryCoverageSize()).toBe(1);
			expect(staleWriteSubjects()).toContain(
				"runtime-session:turn-end:late-aux",
			);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence: the probe-failure re-arm runs after the probe's await. A
	// replacement inside it must not hand the old session's pair to the
	// successor, whose session_start emptied this store.
	it("does not re-arm the replaced session's pair into its successor", async () => {
		const rig = makeRig("pi-lens-4161-aux-rearm-");
		try {
			const file = markAux(rig, "old-aux.ts");
			readCachedDiagnosticsForServers.mockImplementation(async () => {
				replace(rig);
				throw new Error("probe failed");
			});
			await endTurn(rig);
			expect(pendingAuxiliaryCoverageSize()).toBe(0);
			expect(staleWriteSubjects()).toContain(
				"runtime-session:turn-end:late-aux-rearm",
			);
			// Recurrence (#4168 review F2): the dropped re-arm was still counted,
			// so the row read `rearmed: 1` beside `pendingAfter: 0`.
			expect(lateAuxRow()?.metadata).toMatchObject({
				rearmed: 0,
				pendingAfter: 0,
			});
			expect(file).toContain("old-aux.ts");
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence (#4168 review F3): one stale-write subject per pair let a
	// replaced turn's pairs push every other subject out of the kind's
	// 20-entry window. The store is one subject; its count carries N.
	it("records the replaced turn's dropped re-arms under one subject for the store", async () => {
		const rig = makeRig("pi-lens-4161-aux-rearm-subject-");
		try {
			markAux(rig, "old-aux-a.ts");
			markAux(rig, "old-aux-b.ts");
			readCachedDiagnosticsForServers.mockImplementation(async () => {
				replace(rig);
				throw new Error("probe failed");
			});
			await endTurn(rig);
			expect(pendingAuxiliaryCoverageSize()).toBe(0);
			expect(
				staleWriteSubjects().filter((subject) =>
					subject.includes("late-aux-rearm"),
				),
			).toEqual(["runtime-session:turn-end:late-aux-rearm"]);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence (#4168 verify R2-F1, probe S1): round 2 judged a concurrent
	// secondary's drains AND settle by the secondary's own scope. A secondary
	// that drained the primary's run and then ended before settle skipped the
	// restore, so the primary's cut run was lost (head `[]`, master
	// `["primary-built.ts"]`). The store is the coordinator's, so its fence is
	// the coordinator's scope, which is live: settle restores it for the primary.
	it("a secondary that drained the primary's cut run and then ended before settle restores it for the primary", async () => {
		const rig = makeRig("pi-lens-4161-secondary-s1-");
		try {
			fillerBlocker(rig, 1000);
			rig.runtime.appendCascadeRun(cascadeRun(rig, "primary-built"));
			const secondary = beginScope({ role: "secondary" });
			await handleTurnEnd({
				// The knip await sits after `consumeCascadeRuns`, so the retirement
				// lands between the drain and settle.
				...makeDeps(rig.runtime, rig.cacheManager, rig.cwd, () =>
					retireScope(secondary, "shutdown"),
				),
				sessionId: "secondary-4161",
				sessionScope: secondary,
			});
			expect(
				rig.runtime
					.consumeCascadeRuns()
					.map((run) => path.basename(run.filePath)),
			).toEqual(["primary-built.ts"]);
			expect(staleWriteSubjects()).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence (#4168 verify R2-F1, probe S4): the same window on the
	// late-auxiliary store. The secondary drained the primary's pair, its scope
	// ended inside the probe's await, and the still-scanning re-arm was fenced
	// off (head 0, master 1). The store is the module's, shared through the
	// coordinator, so the coordinator's live scope lets the re-arm land.
	it("a secondary that drained the primary's aux pair and then ended before settle re-arms it for the primary", async () => {
		const rig = makeRig("pi-lens-4161-secondary-s4-");
		try {
			markAux(rig, "primary-aux.ts");
			const secondary = beginScope({ role: "secondary" });
			// Alive but not yet published: the drain's own still-scanning branch
			// re-arms the pair after this await.
			readCachedDiagnosticsForServers.mockImplementation(async () => {
				retireScope(secondary, "shutdown");
				return new Map([["opengrep", { diags: [] }]]);
			});
			await handleTurnEnd({
				...makeDeps(rig.runtime, rig.cacheManager, rig.cwd),
				sessionId: "secondary-4161",
				sessionScope: secondary,
			});
			expect(pendingAuxiliaryCoverageSize()).toBe(1);
			expect(lateAuxRow()?.metadata).toMatchObject({
				rearmed: 1,
				pendingAfter: 1,
			});
			expect(staleWriteSubjects()).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence (#4168 verify R2-F2): the "re-arm counted only when it landed"
	// guard was pinned at the probe-failure site alone; making the count
	// unconditional at the other three sites stayed green. One row per site:
	// the replacement lands inside the probe's await, the probe's answer steers
	// the drain into that site's branch, and the row must not claim a re-arm
	// (or a stuck pair) the fence dropped.
	const REARM_SITES = [
		{
			site: "notify-stall",
			markedAgoMs: 2000,
			// The LSP service's teardown status for a pair marked before it.
			probe: () =>
				new Map([
					[
						"opengrep",
						{ diags: [], notifyStallDemoted: true, demotedAt: Date.now() },
					],
				]),
		},
		{
			site: "still-scanning",
			markedAgoMs: 2000,
			// Alive, nothing published yet.
			probe: () => new Map([["opengrep", { diags: [] }]]),
		},
		{
			site: "stale-gate",
			// The file's mtime (now) is past a mark this old, so every finding
			// the probe answers is stale and the drain re-arms with the baseline.
			markedAgoMs: 60_000,
			probe: () =>
				new Map([
					[
						"opengrep",
						{ diags: [auxDiag(0, "stale body")], publishedAt: Date.now() },
					],
				]),
		},
	] as const;

	it.each(REARM_SITES)(
		"does not count a re-arm the fence dropped at the $site site",
		async ({ site, markedAgoMs, probe }) => {
			const rig = makeRig(`pi-lens-4161-aux-rearm-${site}-`);
			try {
				const file = touch(rig, "old-aux.ts");
				markPendingAuxiliaryCoverage(
					file,
					["opengrep"],
					Date.now() - markedAgoMs,
				);
				readCachedDiagnosticsForServers.mockImplementation(async () => {
					replace(rig);
					return probe();
				});
				await endTurn(rig);
				expect(pendingAuxiliaryCoverageSize()).toBe(0);
				expect(staleWriteSubjects()).toContain(
					"runtime-session:turn-end:late-aux-rearm",
				);
				expect(lateAuxRow()?.metadata).toMatchObject({
					rearmed: 0,
					pendingAfter: 0,
					stuckPairs: [],
				});
			} finally {
				rig.cleanup();
			}
		},
	);

	// No-drop direction (shape 54): without a replacement the same turn still
	// drains, settles and restores (the reviewer's control, `[Y, X]`).
	it("restores both cut runs when no replacement lands", async () => {
		const rig = makeRig("pi-lens-4161-control-");
		try {
			fillerBlocker(rig, 1000);
			const oldRun = cascadeRun(rig, "old-pending");
			rig.runtime.appendCascadePromise(
				Promise.resolve(oldRun),
				rig.runtime.captureSessionGeneration(),
				oldRun.filePath,
			);
			rig.runtime.appendCascadeRun(cascadeRun(rig, "old-built"));
			await endTurn(rig);
			expect(
				rig.runtime
					.consumeCascadeRuns()
					.map((run) => path.basename(run.filePath))
					.sort(),
			).toEqual(["old-built.ts", "old-pending.ts"]);
			expect(staleWriteSubjects()).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});
});

describe("F6: a resolved retirement the signature dedupe would suppress (#3813)", () => {
	// Recurrence (#3776 verify r3 F6): an identical second retirement on
	// consecutive turns (same file, count and ordinal) was consumed by the
	// coordinator and then silenced by `turn-end-findings-last`.
	it("delivers the second identical retirement; it is a new event", async () => {
		const rig = makeRig("pi-lens-3813-f6-");
		try {
			const line =
				"Resolved this turn: a.ts (2 blocker(s) cleared by the 5th write)";
			const retire = () => {
				const target = touch(rig, "a.ts", "const a = 1;\nconst b = 2;\n");
				rig.runtime.recordInlineBlockers(
					target,
					"🔴 STOP — 2 issue(s) must be fixed:\n  L1: b0\n  L2: b1",
					3,
					["lsp"],
					[1, 2],
				);
				rig.runtime.clearInlineBlockers(target, 5);
			};
			retire();
			expect(await endTurn(rig)).toContain(line);

			rig.runtime.beginTurn();
			retire();
			expect(await endTurn(rig)).toContain(line);
		} finally {
			rig.cleanup();
		}
	});
});

/** A blocker the agent marked false-positive: the policy suppresses it. */
function markedBlocker(rig: Rig, name: string): string {
	const file = touch(rig, name, "alpha();\n");
	const diagnostic: Diagnostic = {
		id: `ast-grep:${name}:1`,
		message: "alpha is unsafe",
		filePath: file,
		line: 1,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
	};
	const bytes = fs.readFileSync(file);
	rig.runtime.recordInlineBlockers(
		file,
		"🔴 STOP — alpha is unsafe",
		rig.runtime.nextWriteIndex(),
		["ast-grep"],
		[1],
		{
			size: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		},
		[diagnostic],
	);
	markDisposition(
		rig.cwd,
		{
			cwd: rig.cwd,
			filePath: file,
			tool: diagnostic.tool,
			rule: diagnostic.rule,
			message: diagnostic.message,
			line: 1,
			content: fs.readFileSync(file, "utf8"),
		},
		"false-positive",
	);
	return file;
}

describe("F1: a retire a hold commits re-derives the commit-gate latch (#3813 r1)", () => {
	// Recurrence (review r1 F1): `updateGitGuardStatus` counts every map entry,
	// and neither retire re-derived the latch. Moving the past-EOF retire behind
	// the policy re-derive turned a master-open gate (retire + policy suppression
	// in one turn) into a closed one. The same missing re-derive already left the
	// latch set on master after a lone retire.
	it.each([
		{ suppressed: true, what: "a retire and a policy suppression in one turn" },
		{ suppressed: false, what: "a retire alone" },
	])("$what leaves the commit gate open", async ({ suppressed }) => {
		const rig = makeRig("pi-lens-3813-f1-");
		try {
			rig.lensGuard = true;
			if (suppressed) markedBlocker(rig, "marked.ts");
			const file = pastEofRecord(rig, "pe.ts");
			rig.runtime.updateGitGuardStatus(false, "");
			expect(rig.runtime.gitGuardHasBlockers).toBe(true);

			const message = await endTurn(rig);
			expect(message).toContain(RETIRED_NOTE);
			expect(pending(rig, file)).toBe(false);
			expect(rig.runtime.gitGuardHasBlockers).toBe(false);
			expect(evaluateGitGuard(rig.runtime, rig.cacheManager, rig.cwd)).toEqual({
				block: false,
			});
		} finally {
			rig.cleanup();
		}
	});

	it("the dependency-drift cap retire re-derives the latch too", async () => {
		const rig = makeRig("pi-lens-3813-f1-drift-");
		try {
			rig.lensGuard = true;
			const file = driftRecord(rig, "drift-a.ts");
			for (let i = 0; i < DEPENDENCY_DRIFT_MAX_DELIVERIES - 1; i++)
				rig.runtime.incrementInlineBlockerStaleDelivery(file);
			rig.runtime.updateGitGuardStatus(false, "");
			expect(rig.runtime.gitGuardHasBlockers).toBe(true);

			await endTurn(rig);
			expect(pending(rig, file)).toBe(false);
			expect(rig.runtime.gitGuardHasBlockers).toBe(false);
		} finally {
			rig.cleanup();
		}
	});
});

/** `lineCount` lines totalling exactly `chars` chars of one blocker part. */
function linesBlocker(
	rig: Rig,
	name: string,
	chars: number,
	lineCount: number,
): string {
	const file = touch(rig, name);
	const prefix = `Unresolved from this turn — ${name}:\n`;
	const body = chars - prefix.length - (lineCount - 1);
	const base = Math.floor(body / lineCount);
	const extra = body - base * lineCount;
	const lines = Array.from({ length: lineCount }, (_, i) =>
		"y".repeat(base + (i < extra ? 1 : 0)),
	);
	const summary = lines.join("\n");
	expect(prefix.length + summary.length).toBe(chars);
	rig.runtime.recordInlineBlockers(
		file,
		summary,
		rig.runtime.nextWriteIndex(),
		["eslint"],
		[1],
	);
	return file;
}

const MARKERS = /\.\.\. \(/g;

describe("F5: the truncation marker never garbles the message (#3813 r1)", () => {
	// Recurrence (review r1 F5): the 20-line cut appended the marker and the
	// char axis then cut THAT, leaving a half-printed marker before a second
	// one. The band is a 20-line prefix of 985-1000 chars (held=0) or 959-1000
	// (the longer held marker).
	it.each([
		{ held: 1, chars: 960, what: "a held-count marker" },
		{ held: 0, chars: 990, what: "the plain marker" },
	])(
		"$what is printed once, whole, after a 20-line cut",
		async ({ held, chars }) => {
			const rig = makeRig("pi-lens-3813-f5-");
			try {
				// 19 lines + the blank separator = the 20 lines the cap keeps.
				linesBlocker(rig, "lines.ts", chars, 19);
				if (held > 0) pastEofRecord(rig, "pe-a.ts");
				else linesBlocker(rig, "more.ts", 300, 6);
				const message = await endTurn(rig);
				const body = message.slice(message.indexOf("Unresolved"));
				expect(body.match(MARKERS)).toHaveLength(1);
				expect(
					body.endsWith(
						held > 0 ? "(truncated; 1 held for the next turn)" : "(truncated)",
					),
				).toBe(true);
			} finally {
				rig.cleanup();
			}
		},
	);
});

describe("F2: an oversized part is reached only when it leads the message (#3813 r1)", () => {
	// Recurrence (review r1 F2): "its head is kept" held for one character.
	// A blocking cascade section was consumed with `Cascade error` shown, and a
	// past-EOF record retired with `ℹ️ Advisory —` shown.
	const BIG = Array.from(
		{ length: 40 },
		(_, i) => `L${i} ${"q".repeat(40)}`,
	).join("\n");

	async function drain(rig: Rig, fillerFile: string, done: () => boolean) {
		// The cleared filler leaves a one-line Resolved report ahead of the
		// part for one turn; the part leads the turn after.
		clearFiller(rig, fillerFile);
		for (let turn = 2; turn <= 4 && !done(); turn++) {
			nextTurn(rig, turn);
			await endTurn(rig);
		}
		expect(done()).toBe(true);
	}

	it("holds a past-EOF record shown only as a sliver, then retires it when it leads", async () => {
		const rig = makeRig("pi-lens-3813-f2-pe-");
		try {
			const fillerFile = fillerBlocker(rig, 985);
			const file = pastEofRecord(rig, "pe-big.ts", BIG);
			const first = await endTurn(rig);
			expect(first).toContain("ℹ️ Advisory");
			expect(first).not.toContain("pe-big.ts");
			expect(pending(rig, file)).toBe(true);
			await drain(rig, fillerFile, () => !pending(rig, file));
		} finally {
			rig.cleanup();
		}
	});

	it("holds a cascade section shown only as a sliver, then consumes it when it leads", async () => {
		const rig = makeRig("pi-lens-3813-f2-casc-");
		try {
			const fillerFile = fillerBlocker(rig, 985);
			const primary = touch(rig, "casc-primary.ts");
			const neighbor = touch(rig, "casc-dep.ts");
			rig.runtime.appendCascadeRun({
				filePath: primary,
				result: cascadeResult(primary, neighbor, BIG),
				neighborCount: 1,
				diagnosticCount: 1,
			});
			const first = await endTurn(rig);
			expect(first).toContain("Cascade");
			expect(first).not.toContain("casc-dep.ts");
			expect(rig.runtime.hasCascadeRuns()).toBe(true);
			await drain(rig, fillerFile, () => !rig.runtime.hasCascadeRuns());
		} finally {
			rig.cleanup();
		}
	});

	it("holds a runner result shown only as a sliver, then consumes it when it leads", async () => {
		const rig = makeRig("pi-lens-3813-f2-run-");
		try {
			const fillerFile = fillerBlocker(rig, 985);
			const file = path.join(rig.cwd, "run-a.ts");
			deferSettled(rig, "run-a.ts", {
				status: "succeeded",
				semantic: "warning",
				diagnostics: [
					runnerDiagnostic(file, `${"r".repeat(1500)}${RUNNER_END}`),
				],
			});
			const first = await endTurn(rig);
			expect(first).not.toContain("Late runner");
			expect(pendingRunnerFindingsSize()).toBe(1);
			await drain(rig, fillerFile, () => pendingRunnerFindingsSize() === 0);
		} finally {
			rig.cleanup();
		}
	});
});
