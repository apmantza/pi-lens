/**
 * #3813 / #3901 — an item-bearing advisory that `handleTurnEnd` derives from
 * "what this turn changed" must not be lost when `capTurnEndMessage` cuts it.
 *
 * Recurrence (PR #3900 residuals, #3901): knip and dead-code deltas are
 * `this scan minus the previous scan`, and the scan cache is overwritten
 * BEFORE the cap runs, so an item the cap cut never reappeared as new on the
 * next turn. The call-graph impact lines are derived from the turn's edited
 * files, which the worklist retires once a turn ends without blockers. The
 * `planDeliveryHolds` seam (#3900) restores drained queues; these producers
 * have no queue, so a cut part parks its items on the coordinator
 * (`runtime.parkCutAdvisoryItems`; offered once, re-checked against the next
 * scan, keyed by part kind AND by the session that cut it) instead.
 *
 * Every test drives the REAL `handleTurnEnd` and reads the delivered message
 * the way production does. The cap is never mocked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: () => makeLspServiceDouble({}),
}));

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Parameters<typeof actual.logLatency>[0]) => {
			logLatency(entry);
			actual.logLatency(entry);
		},
	};
});

import { resetBoundedTelemetry } from "../../clients/bounded-telemetry.js";
import { CacheManager } from "../../clients/cache-manager.js";
import type { FunctionCallGraph } from "../../clients/call-graph.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _resetStateCacheForTests } from "../../clients/diagnostic-dispositions.js";
import { loadProjectDiagnosticsDeltaReport } from "../../clients/project-diagnostics/cache.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const SESSION = "session-3901";

const EMPTY_KNIP = {
	success: true,
	issues: [] as Array<Record<string, unknown>>,
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "ok",
};

interface Scan {
	knip: Array<Record<string, unknown>>;
	/** The next knip scan fails (a timeout), leaving the last good cache. */
	knipFails?: boolean;
	/** Host flags turned on for the turn. */
	flags?: Set<string>;
	/** Runs inside the knip scan's await, where a test can change the world. */
	duringKnipScan?: () => void | Promise<void>;
	/**
	 * The dead-code scan reports this start stamp: a scan that was already
	 * running when the lane asked, which the lane parks (#4154 J1).
	 */
	deadCodeScannedAt?: string;
	deadCode: Array<Record<string, unknown>>;
}

interface Rig {
	cwd: string;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	/** What the next scans report; mutated between turns. */
	scan: Scan;
	cleanup: () => void;
}

function makeRig(prefix: string): Rig {
	const env = setupTestEnvironment(prefix);
	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: SESSION });
	runtime.beginTurn();
	const cacheManager = new CacheManager(false);
	// The baselines the deltas are computed against.
	cacheManager.writeCache("knip", { ...EMPTY_KNIP }, env.tmpDir);
	cacheManager.writeCache(
		"dead-code-vulture",
		{ ...EMPTY_KNIP, language: "python" },
		env.tmpDir,
	);
	return {
		cwd: env.tmpDir,
		runtime,
		cacheManager,
		scan: { knip: [], deadCode: [] },
		cleanup: env.cleanup,
	};
}

function makeDeps(rig: Rig, sessionId?: string) {
	return {
		ctxCwd: rig.cwd,
		...(sessionId === undefined ? {} : { sessionId }),
		getFlag: (name: string) => rig.scan.flags?.has(name) ?? false,
		dbg: () => {},
		runtime: rig.runtime,
		cacheManager: rig.cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => {
				await rig.scan.duringKnipScan?.();
				return rig.scan.knipFails
					? { ...EMPTY_KNIP, success: false, summary: "knip failed" }
					: {
							...EMPTY_KNIP,
							issues: rig.scan.knip,
							unusedExports: rig.scan.knip,
						};
			},
		},
		deadCodeClients: [
			{
				id: "vulture",
				language: "python",
				detect: () => true,
				owns: () => true,
				ensureAvailable: async () => true,
				analyze: async () => ({
					...EMPTY_KNIP,
					language: "python",
					unusedExports: rig.scan.deadCode,
					...(rig.scan.deadCodeScannedAt === undefined
						? {}
						: { scannedAt: rig.scan.deadCodeScannedAt }),
				}),
			},
		],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

function touch(rig: Rig, name: string, content = "export const a = 1;\n") {
	const file = path.join(rig.cwd, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
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

/** `sessionId`: the stable id index.ts passes; a concurrent secondary has its own. */
async function endTurn(rig: Rig, sessionId?: string): Promise<string> {
	await handleTurnEnd(makeDeps(rig, sessionId));
	return (
		consumeTurnEndFindings(rig.cacheManager, rig.cwd, rig.runtime)
			?.messages?.[0]?.content ?? ""
	);
}

/** Next turn with a noise edit so the signature dedupe never hides a re-offer. */
function nextTurn(rig: Rig, turn: number): void {
	rig.runtime.beginTurn();
	touch(rig, `noise-${turn}.ts`, `export const n${turn} = ${turn};\n`);
}

/**
 * A live blocker whose part is EXACTLY `chars` long, so the part after it
 * starts at `chars + 2` and the cap cell it lands in is arithmetic.
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
	rig.runtime.recordInlineBlockers(
		file,
		summary,
		rig.runtime.nextWriteIndex(),
		["eslint"],
		[1],
	);
	return file;
}

function clearFiller(rig: Rig, file: string): void {
	rig.runtime.clearInlineBlockers(file, rig.runtime.nextWriteIndex());
}

/** What a turn that ended without blockers does to the edited-file worklist. */
function retireWorklist(rig: Rig): void {
	rig.cacheManager.clearTurnState(rig.cwd, { kind: "pi", id: SESSION });
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
});

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
	resetDegradationLedger();
	resetBoundedTelemetry();
});

/**
 * Where the part lands relative to the cap. The filler is the live blocker
 * riding before it; the next part starts at `filler + 2` and the cap keeps
 * 1000 chars. Every fixture part is 110-300 chars, so 300 fits it whole, 930
 * cuts it mid-text and 1000 cuts it away entirely.
 */
const CELLS = [
	{ cell: "fits", filler: 300, reached: true },
	{ cell: "partially cut", filler: 930, reached: false },
	{ cell: "fully cut", filler: 1000, reached: false },
] as const;

describe("knip blocker vs the cap (#3901)", () => {
	const issue = {
		type: "unlisted",
		name: "left-pad",
		file: "edited.ts",
		line: 1,
	};

	it.each(CELLS)(
		"$cell: a cut blocker is re-offered next turn, once",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3901-knip-blocker-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				touch(rig, "edited.ts");
				rig.scan.knip = [issue];

				const first = await endTurn(rig);
				expect(first.includes("left-pad")).toBe(reached);

				// The same scan again: the issue is in the baseline now.
				clearFiller(rig, fillerFile);
				nextTurn(rig, 2);
				const second = await endTurn(rig);
				expect(second.includes("left-pad")).toBe(!reached);

				nextTurn(rig, 3);
				const third = await endTurn(rig);
				expect(third).not.toContain("left-pad");
			} finally {
				rig.cleanup();
			}
		},
	);

	it("re-offers a cut blocker though the turn worklist was retired", async () => {
		const rig = makeRig("pi-lens-3901-knip-worklist-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue];
			expect(await endTurn(rig)).not.toContain("left-pad");

			// A turn that ended without blockers retires the worklist; the cut
			// item's file is no longer "modified" on the next turn.
			clearFiller(rig, fillerFile);
			retireWorklist(rig);
			nextTurn(rig, 2);
			expect(await endTurn(rig)).toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	it("does not re-offer a cut item the next scan no longer reports", async () => {
		const rig = makeRig("pi-lens-3901-knip-fresh-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue];
			await endTurn(rig);

			// The agent fixed it between the turns: a stale nudge is worse than none.
			clearFiller(rig, fillerFile);
			rig.scan.knip = [];
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	it("bounds the carry: an item cut on two consecutive turns is dropped with one record", async () => {
		const rig = makeRig("pi-lens-3901-knip-bound-");
		try {
			fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue];
			await endTurn(rig);

			// The filler stays live: the carried item is cut again.
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("left-pad");
			expect(ledgerCount("turn-end-advisory-carry-dropped")).toBe(1);
			// Only the first cut was "held for the next turn"; the second promised
			// nothing, so the marker and the held row do not claim it.
			expect(ledgerCount("turn-end-sections-held")).toBe(1);

			nextTurn(rig, 3);
			expect(await endTurn(rig)).not.toContain("left-pad");
			expect(ledgerCount("turn-end-advisory-carry-dropped")).toBe(1);
		} finally {
			rig.cleanup();
		}
	});
});

describe("knip carry bounds and neighbours (#3901)", () => {
	const issue = (name: string) => ({
		type: "unlisted",
		name,
		file: "edited.ts",
		line: 1,
	});

	// Recurrence guard: a carried item riding beside a fresh one would be
	// re-parked with it and re-offered every turn (shape 9, one-axis bound).
	it("parks only the fresh item of a part that mixes a re-offer and a new one", async () => {
		const rig = makeRig("pi-lens-3901-knip-mixed-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("pkg-old")];
			await endTurn(rig);

			// Turn 2: the old item is re-offered beside a new one, filler still live.
			nextTurn(rig, 2);
			rig.scan.knip = [issue("pkg-old"), issue("pkg-new")];
			expect(await endTurn(rig)).not.toContain("pkg-");
			// pkg-old was a re-offer: dropped and counted. pkg-new: parked.
			expect(ledgerCount("turn-end-advisory-carry-dropped")).toBe(1);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 3);
			const third = await endTurn(rig);
			expect(third).toContain("pkg-new");
			expect(third).not.toContain("pkg-old");

			nextTurn(rig, 4);
			expect(await endTurn(rig)).not.toContain("pkg-");
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard: a failed scan must not spend the parked item (the
	// poison guard keeps the last good cache; the item is still unannounced).
	it("keeps a parked item across a failed scan and offers it on the next good one", async () => {
		const rig = makeRig("pi-lens-3901-knip-failed-scan-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("left-pad")];
			await endTurn(rig);

			clearFiller(rig, fillerFile);
			rig.scan.knipFails = true;
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("left-pad");

			rig.scan.knipFails = false;
			nextTurn(rig, 3);
			expect(await endTurn(rig)).toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard: parked state is a fact about the session that parked it.
	it("a new session does not inherit a parked item", async () => {
		const rig = makeRig("pi-lens-3901-knip-session-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("left-pad")];
			await endTurn(rig);

			clearFiller(rig, fillerFile);
			rig.runtime.resetForSession();
			rig.runtime.setTelemetryIdentity({ sessionId: SESSION });
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard (#3901 AC2): the shared caches `lens_diagnostics` reads
	// are never mutated by the hold, and a re-offer does not write the item into
	// the delta a second time.
	it("leaves the knip cache and the persisted delta exactly as an uncut turn writes them", async () => {
		const rig = makeRig("pi-lens-3901-knip-caches-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("left-pad")];
			await endTurn(rig);

			const cached = rig.cacheManager.readCache<{
				issues: Array<{ name: string }>;
			}>("knip", rig.cwd);
			expect(cached?.data.issues.map((i) => i.name)).toEqual(["left-pad"]);
			const delta = loadProjectDiagnosticsDeltaReport(rig.cwd);
			expect(JSON.stringify(delta?.diagnostics)).toContain("left-pad");

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			expect(await endTurn(rig)).toContain("left-pad");
			expect(
				rig.cacheManager.readCache<{ issues: unknown[] }>("knip", rig.cwd)?.data
					.issues,
			).toHaveLength(1);
			// The re-offer finds nothing NEW, so it writes no delta of its own: the
			// cut turn's report is byte-for-byte what it was.
			expect(loadProjectDiagnosticsDeltaReport(rig.cwd)).toEqual(delta);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard: an eviction the bound forces is a lost item; it is
	// counted, not silent (shape 9, a resource bounded on one axis only).
	it("counts the parked lane the bound evicts when a cut part parks its items", async () => {
		const rig = makeRig("pi-lens-3901-knip-evict-");
		try {
			for (let i = 0; i < 16; i += 1) {
				rig.runtime.parkCutAdvisoryItems(`other-${i}`, [i]);
			}
			fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("left-pad")];
			await endTurn(rig);
			expect(ledgerCount("turn-end-advisory-carry-dropped")).toBe(1);
			expect(rig.runtime.takeCutAdvisoryItems("other-0")).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard (review r1 F1): the blocker and the advisory share a
	// scan, hold order is part order, and the cap that cuts a blocker always
	// cuts the advisory behind it. One lane for both parts let the advisory's
	// park REPLACE the blocker's, so the unresolved-import blocker (the exact
	// #3901 case) never came back, uncounted.
	it("re-offers a cut blocker AND a cut advisory of one scan, each once", async () => {
		const rig = makeRig("pi-lens-3901-knip-both-parts-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [
				issue("left-pad"),
				{ type: "export", name: "orphanFn", file: "edited.ts", line: 1 },
			];
			const first = await endTurn(rig);
			expect(first).not.toContain("left-pad");
			expect(first).not.toContain("orphanFn");

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			const second = await endTurn(rig);
			expect(second).toContain("left-pad");
			expect(second).toContain("orphanFn");

			nextTurn(rig, 3);
			const third = await endTurn(rig);
			expect(third).not.toContain("left-pad");
			expect(third).not.toContain("orphanFn");
			expect(ledgerCount("turn-end-advisory-carry-dropped")).toBe(0);
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard (review r1 F2): the runtime is a process singleton and a
	// concurrent secondary (subagent) activation runs handleTurnEnd on it with
	// its own session id. #3900's `holdGeneration` is the runtime's scope id, the
	// same for both, so it cannot tell them apart; the turn's session id can.
	it("a same-root secondary turn neither takes nor shows the primary's parked item", async () => {
		const rig = makeRig("pi-lens-3901-knip-secondary-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			touch(rig, "edited.ts");
			rig.scan.knip = [issue("left-pad")];
			await endTurn(rig);

			clearFiller(rig, fillerFile);
			nextTurn(rig, 2);
			const secondary = await endTurn(rig, "secondary-session");
			expect(secondary).not.toContain("left-pad");

			nextTurn(rig, 3);
			expect(await endTurn(rig)).toContain("left-pad");
		} finally {
			rig.cleanup();
		}
	});

	// Recurrence guard: the parked-lane store is bounded on the lane axis too.
	it("evicts the oldest parked lane past 16 lanes", () => {
		const runtime = new RuntimeCoordinator();
		for (let i = 0; i < 16; i += 1) {
			expect(runtime.parkCutAdvisoryItems(`lane-${i}`, [i])).toEqual([]);
		}
		expect(runtime.parkCutAdvisoryItems("lane-over", [1])).toEqual(["lane-0"]);
		expect(runtime.takeCutAdvisoryItems("lane-0")).toEqual([]);
		expect(runtime.takeCutAdvisoryItems("lane-over")).toEqual([1]);
		// Taken once.
		expect(runtime.takeCutAdvisoryItems("lane-over")).toEqual([]);
	});
});

describe("knip advisory vs the cap (#3901)", () => {
	const issue = {
		type: "export",
		name: "orphanFn",
		file: "edited.ts",
		line: 1,
	};

	it.each(CELLS)(
		"$cell: a cut advisory is re-offered next turn, once",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3901-knip-advisory-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				touch(rig, "edited.ts");
				rig.scan.knip = [issue];

				const first = await endTurn(rig);
				expect(first.includes("orphanFn")).toBe(reached);

				clearFiller(rig, fillerFile);
				nextTurn(rig, 2);
				const second = await endTurn(rig);
				expect(second.includes("orphanFn")).toBe(!reached);

				nextTurn(rig, 3);
				expect(await endTurn(rig)).not.toContain("orphanFn");
			} finally {
				rig.cleanup();
			}
		},
	);
});

describe("dead-code advisory vs the cap (#3901)", () => {
	const issue = (file: string) => ({
		category: "export",
		kind: "function",
		name: "orphanPy",
		file,
		line: 1,
	});

	it.each(CELLS)(
		"$cell: a cut advisory is re-offered next turn, once",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3901-dead-code-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				const edited = touch(rig, "edited.py", "def orphanPy():\n    pass\n");
				rig.scan.deadCode = [issue(edited)];

				const first = await endTurn(rig);
				expect(first.includes("orphanPy")).toBe(reached);

				clearFiller(rig, fillerFile);
				retireWorklist(rig);
				nextTurn(rig, 2);
				const second = await endTurn(rig);
				expect(second.includes("orphanPy")).toBe(!reached);

				nextTurn(rig, 3);
				expect(await endTurn(rig)).not.toContain("orphanPy");
			} finally {
				rig.cleanup();
			}
		},
	);

	it("does not re-offer a cut item the next scan no longer reports", async () => {
		const rig = makeRig("pi-lens-3901-dead-code-fresh-");
		try {
			const fillerFile = fillerBlocker(rig, 1000);
			const edited = touch(rig, "edited.py", "def orphanPy():\n    pass\n");
			rig.scan.deadCode = [issue(edited)];
			await endTurn(rig);

			clearFiller(rig, fillerFile);
			rig.scan.deadCode = [];
			nextTurn(rig, 2);
			expect(await endTurn(rig)).not.toContain("orphanPy");
		} finally {
			rig.cleanup();
		}
	});
});

describe("a concurrent secondary does not spend the primary's parked items (review r1 F2)", () => {
	// Dead-code and call-graph lanes carry no scan root, so a secondary on a
	// DIFFERENT root reached them too: its scan found nothing, and the take
	// dropped the primary's item.
	it("dead-code: primary cut, secondary turn on another root, primary re-offers", async () => {
		const primary = makeRig("pi-lens-3901-dead-code-primary-");
		const secondary = makeRig("pi-lens-3901-dead-code-secondary-");
		try {
			secondary.runtime = primary.runtime;
			const fillerFile = fillerBlocker(primary, 1000);
			const edited = touch(primary, "edited.py", "def orphanPy():\n    pass\n");
			primary.scan.deadCode = [
				{
					category: "export",
					kind: "function",
					name: "orphanPy",
					file: edited,
					line: 1,
				},
			];
			expect(await endTurn(primary)).not.toContain("orphanPy");

			clearFiller(primary, fillerFile);
			touch(secondary, "other.py", "def other():\n    pass\n");
			expect(await endTurn(secondary, "secondary-session")).not.toContain(
				"orphanPy",
			);

			nextTurn(primary, 2);
			expect(await endTurn(primary)).toContain("orphanPy");
		} finally {
			secondary.cleanup();
			primary.cleanup();
		}
	});
});

function graphWith(callee: string, callers: string[]): FunctionCallGraph {
	return {
		callees: new Map(),
		callers: new Map([[callee, new Set(callers)]]),
		edges: callers.map((callerKey) => ({
			callerKey,
			calleeKey: callee,
			weight: 1,
			evidenceCount: 1,
		})) as any,
		inDegree: new Map(),
		unresolvedRefs: 0,
		totalRefs: callers.length,
		coverage: { complete: true } as any,
		builtAt: new Date().toISOString(),
	};
}

describe("call-graph impact advisory vs the cap (#3813)", () => {
	it.each(CELLS)(
		"$cell: cut impact lines are re-offered next turn, once",
		async ({ filler, reached }) => {
			const rig = makeRig("pi-lens-3813-call-graph-");
			try {
				const fillerFile = fillerBlocker(rig, filler);
				const edited = touch(rig, "src/core.ts");
				const caller = touch(rig, "src/caller.ts");
				rig.runtime.callGraph = graphWith(`${edited}:doThing`, [
					`${caller}:liveCaller`,
				]);

				const first = await endTurn(rig);
				expect(first.includes("liveCaller")).toBe(reached);

				clearFiller(rig, fillerFile);
				retireWorklist(rig);
				nextTurn(rig, 2);
				const second = await endTurn(rig);
				expect(second.includes("liveCaller")).toBe(!reached);

				nextTurn(rig, 3);
				expect(await endTurn(rig)).not.toContain("liveCaller");
			} finally {
				rig.cleanup();
			}
		},
	);
});

// Decision pin, not a feature: these two advisories are COUNT-AND-POINTER
// nudges ("N warnings; use lens_diagnostics mode=delta"), built from a
// per-turn collector that `beginTurn` itself clears, and their full content is
// persisted in a report the pull surface reads. A cut one costs the pointer,
// never the findings. Recurrence it prevents: treating them like the
// item-bearing advisories above and re-offering a "this turn" count on a turn
// whose edits it does not describe (#3813 class sweep, PR #3900 r1 F4).
describe("pointer-only advisories keep their pull record when the cap cuts them (#3813)", () => {
	const POINTER_CELLS = [
		{ cell: "fits (control)", filler: 300, shown: true },
		{ cell: "fully cut", filler: 1000, shown: false },
	] as const;

	it.each(POINTER_CELLS)(
		"code-quality, $cell: the persisted report holds the warnings",
		async ({ filler, shown }) => {
			const rig = makeRig("pi-lens-3813-code-quality-");
			try {
				fillerBlocker(rig, filler);
				const edited = touch(rig, "edited.ts");
				rig.runtime.recordCodeQualityWarnings([
					{
						id: "cq:1",
						filePath: edited,
						displayPath: "edited.ts",
						line: 1,
						severity: "warning",
						tool: "ast-grep",
						rule: "too-long",
						message: "function too long",
						category: "maintainability",
						origin: "dispatch",
					},
				]);

				const first = await endTurn(rig);
				expect(first.includes("Code-quality warnings introduced")).toBe(shown);
				const report = rig.cacheManager.readCache<{
					summary: { warnings: number };
				}>("code-quality-warnings", rig.cwd)?.data;
				expect(report?.summary.warnings).toBe(1);

				nextTurn(rig, 2);
				expect(await endTurn(rig)).not.toContain(
					"Code-quality warnings introduced",
				);
			} finally {
				rig.cleanup();
			}
		},
	);

	it.each(POINTER_CELLS)(
		"actionable warnings, $cell: the persisted report holds the warnings",
		async ({ filler, shown }) => {
			const rig = makeRig("pi-lens-3813-actionable-");
			try {
				rig.scan.flags = new Set(["lens-actionable-warnings"]);
				fillerBlocker(rig, filler);
				const edited = touch(rig, "edited.ts");
				rig.runtime.recordActionableWarnings([
					{
						id: "aw:1",
						filePath: edited,
						displayPath: "edited.ts",
						line: 1,
						severity: "warning",
						tool: "ast-grep",
						rule: "no-console",
						message: "console call",
						actions: [],
						suppressed: false,
						origin: "dispatch",
					},
				]);

				const first = await endTurn(rig);
				expect(first.includes("Fixable warnings introduced this turn")).toBe(
					shown,
				);
				const report = rig.cacheManager.readCache<{
					summary: { unsuppressed: number };
				}>("actionable-warnings", rig.cwd)?.data;
				expect(report?.summary.unsuppressed).toBe(1);

				nextTurn(rig, 2);
				expect(await endTurn(rig)).not.toContain(
					"Fixable warnings introduced this turn",
				);
			} finally {
				rig.cleanup();
			}
		},
	);
});

/**
 * #4161: a turn end whose session was replaced while it awaited takes
 * nothing its successor parked. A sequential replacement with the same stable
 * id (resume, `session-lifecycle.ts` same-session branch) parks under the same
 * lane key, so before the fence the old turn took the successor's item after
 * its scan await, the cap cut it, and the skipped settle never re-parked it.
 * One row per take site (#4168 review F4: un-fencing one site alone must red).
 */
describe("#4161: a replaced turn takes nothing its successor parked", () => {
	const LANES = [
		{
			lane: "knip",
			marker: "left-pad",
			setup: (rig: Rig) => {
				touch(rig, "edited.ts");
				rig.scan.knip = [
					{ type: "unlisted", name: "left-pad", file: "edited.ts", line: 1 },
				];
			},
		},
		{
			lane: "dead-code",
			marker: "orphanPy",
			setup: (rig: Rig) => {
				const edited = touch(rig, "edited.py", "def orphanPy():\n    pass\n");
				rig.scan.deadCode = [
					{
						category: "export",
						kind: "function",
						name: "orphanPy",
						file: edited,
						line: 1,
					},
				];
			},
		},
		{
			lane: "call-graph",
			marker: "liveCaller",
			setup: (rig: Rig) => {
				const edited = touch(rig, "src/core.ts");
				const caller = touch(rig, "src/caller.ts");
				rig.runtime.callGraph = graphWith(`${edited}:doThing`, [
					`${caller}:liveCaller`,
				]);
			},
		},
	] as const;

	it.each(LANES)(
		"$lane: the successor's parked item reaches the successor",
		async ({ lane, marker, setup }) => {
			const rig = makeRig(`pi-lens-4161-${lane}-park-`);
			try {
				const parks = vi.spyOn(rig.runtime, "parkCutAdvisoryItems");
				const fillerFile = fillerBlocker(rig, 1000);
				setup(rig);
				expect(await endTurn(rig)).not.toContain(marker);
				// What the cut turn parked, as its own call wrote it.
				const parked = parks.mock.calls.filter(([, items]) => items.length > 0);
				expect(parked).toHaveLength(1);

				retireWorklist(rig);
				nextTurn(rig, 2);
				rig.scan.duringKnipScan = () => {
					rig.scan.duringKnipScan = undefined;
					rig.runtime.resetForSession();
					rig.runtime.setTelemetryIdentity({ sessionId: SESSION });
					// The successor's own cut turn parked the same item under its key.
					for (const [key, items] of parked)
						rig.runtime.parkCutAdvisoryItems(key, items);
				};
				await endTurn(rig);

				clearFiller(rig, fillerFile);
				retireWorklist(rig);
				nextTurn(rig, 3);
				expect(await endTurn(rig)).toContain(marker);
				expect(
					getDegradationSummary()
						.filter((entry) => entry.kind === "generation-guard-stale-write")
						.flatMap((entry) => entry.latestReasons.map((r) => r.subject)),
				).toContain(`runtime-session:turn-end:${parked[0]?.[0]}`);
			} finally {
				rig.cleanup();
			}
		},
	);

	// Recurrence (#4168 review F1): the late dead-code scan cell was read
	// through the LIVE `runtime.sessionScope` after the knip await, on the
	// MCP and harness route (no `deps.sessionScope`). The replaced turn took
	// the successor's settled scan, the cap cut its part, and the finding was
	// gone. The successor parks its scan the real way: its own turn joins a
	// scan older than its edit (#4154 J1).
	it("the successor's late dead-code scan reaches the successor", async () => {
		const rig = makeRig("pi-lens-4161-late-scan-");
		try {
			fillerBlocker(rig, 1000);
			touch(rig, "old-edit.ts");
			rig.scan.duringKnipScan = async () => {
				rig.scan.duringKnipScan = undefined;
				rig.runtime.resetForSession();
				rig.runtime.setTelemetryIdentity({ sessionId: SESSION });
				const edited = touch(rig, "edited.py", "def orphanPy():\n    pass\n");
				rig.scan.deadCode = [
					{
						category: "export",
						kind: "function",
						name: "orphanPy",
						file: edited,
						line: 1,
					},
				];
				rig.scan.deadCodeScannedAt = new Date(
					Date.now() - 60_000,
				).toISOString();
				// The successor's turn: its scan is parked, and settles.
				await endTurn(rig);
				rig.scan.deadCodeScannedAt = undefined;
			};
			await endTurn(rig);

			retireWorklist(rig);
			nextTurn(rig, 3);
			expect(await endTurn(rig)).toContain("orphanPy");
		} finally {
			rig.cleanup();
		}
	});
});
