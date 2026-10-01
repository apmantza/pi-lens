/**
 * #3218 criterion 2 — the turn-end "Resolved this turn" line.
 *
 * Recurrence (2026-09-19 pi-webaio session, turns 300-302): an inline blocker
 * recorded on an edit (`osTmpdir` unused, 08:40:05) was retired by the next
 * dispatch of the same file (08:40:54, "clean"), and a second (`FetchError`
 * unused, 07:23:34) retired at 07:27. Neither was ever re-delivered — the
 * turn-state, the session record, the project snapshot and every context
 * injection were checked. At 08:54 the agent re-read its own STOP blocks from
 * context and spent two turns re-litigating whether the two ts:6133 hints were
 * real. pi-lens gave the agent the negative (a later clean result) but never
 * the positive: nothing said the blocker it had been shown was closed.
 *
 * The tests drive the REAL `RuntimeCoordinator` retire seams and the REAL
 * turn-end composer (`handleTurnEnd`), then read the delivered content the way
 * production does (`consumeTurnEndFindings`) and the `turn_end` `tool_result`
 * row the monitor reads.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

const SUMMARY = "🔴 STOP — 2 issue(s) must be fixed:\n  L1: b0\n  L2: b1";

function blockerDiagnostics(count: number): Diagnostic[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `b${index}`,
		message: `blocker ${index}`,
		filePath: "a.ts",
		line: index + 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
	}));
}

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
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
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

/** End one turn and return what the agent sees, consumed like production. */
async function runTurnEnd(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	lensGuard = false,
): Promise<string> {
	await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd, lensGuard));
	return (
		consumeTurnEndFindings(cacheManager, cwd, runtime)?.messages?.[0]
			?.content ?? ""
	);
}

/** One `turn_end` tool_result metadata field, from every row so far. */
function turnEndMetadata(field: string): Array<number | undefined> {
	return logLatency.mock.calls
		.map((call) => call[0])
		.filter(
			(entry: any) =>
				entry?.type === "tool_result" && entry?.toolName === "turn_end",
		)
		.map((entry: any) => entry?.metadata?.[field]);
}

/** `resolvedBlockerFiles` from every `turn_end` tool_result so far. */
function resolvedBlockerFileCounts(): Array<number | undefined> {
	return turnEndMetadata("resolvedBlockerFiles");
}

/** Seed a recorded blocker, a clean dispatch that clears it, a touched turn. */
function seedResolvedBlocker(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	target: string,
): void {
	fs.writeFileSync(target, "const a = 1;\nconst b = 2;\n");
	runtime.bumpFileSeq(target);
	runtime.recordInlineBlockers(
		target,
		SUMMARY,
		3,
		["lsp"],
		[1, 2],
		undefined,
		blockerDiagnostics(2),
	);
	// The next dispatch of the same file comes back clean under a later write.
	runtime.clearInlineBlockers(target, 5);
	cacheManager.addModifiedRange(
		target,
		{ start: 1, end: 1 },
		false,
		cwd,
		"session-3218",
	);
}

beforeEach(() => {
	resetDegradationLedger();
});

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
	resetDegradationLedger();
});

describe("turn-end resolved blockers (#3218 criterion 2)", () => {
	it("names a file whose blocker a clean dispatch retired, with count and write", async () => {
		const env = setupTestEnvironment("pi-lens-3218-resolved-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			seedResolvedBlocker(runtime, cacheManager, env.tmpDir, target);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).toContain(
				"Resolved this turn: a.ts (2 blocker(s) cleared by the 5th write)",
			);
			expect(resolvedBlockerFileCounts()).toEqual([1]);
		} finally {
			env.cleanup();
		}
	});

	it("names a file retired by a confirmed-clean check on a read-only turn", async () => {
		// Recurrence (review-3776 F2/F4): `lens_diagnostics` confirms clean on a
		// turn with NO modified files, which takes the read-only early return;
		// the round-1 test called `addModifiedRange` first and never reached it.
		// No write happened, so the line must not claim one.
		for (const lensGuard of [false, true]) {
			logLatency.mockClear();
			const env = setupTestEnvironment("pi-lens-3218-retire-");
			try {
				const runtime = new RuntimeCoordinator();
				runtime.setTelemetryIdentity({ sessionId: "session-3218" });
				runtime.beginTurn();
				const cacheManager = new CacheManager(false);
				const target = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(target, "const a = 1;\nconst b = 2;\n");
				runtime.recordInlineBlockers(
					target,
					SUMMARY,
					runtime.nextWriteIndex(),
					["lsp"],
					[1, 2],
					undefined,
					blockerDiagnostics(2),
				);
				// `lens_diagnostics` reserves a turn-leading order token (#3540).
				const order = runtime.nextWriteOrderToken();
				expect(
					runtime.retireInlineBlockerOnConfirmedClean(target, order, ["lsp"]),
				).toBe(true);
				expect(cacheManager.readTurnState(env.tmpDir).files).toEqual({});

				const content = await runTurnEnd(
					runtime,
					cacheManager,
					env.tmpDir,
					lensGuard,
				);

				expect(content).toContain(
					"Resolved this turn: a.ts (2 blocker(s) confirmed clean)",
				);
				expect(content).not.toContain("cleared by");
				expect(resolvedBlockerFileCounts()).toEqual([1]);
			} finally {
				env.cleanup();
			}
		}
	});

	it("does not invent a resolved line when no blocker was recorded", async () => {
		const env = setupTestEnvironment("pi-lens-3218-none-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(target, "const a = 1;\n");
			runtime.bumpFileSeq(target);
			// A clean dispatch for a file that never had a blocker.
			expect(runtime.clearInlineBlockers(target, 1)).toBe(true);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).not.toContain("Resolved this turn");
			expect(resolvedBlockerFileCounts()).toEqual([0]);
		} finally {
			env.cleanup();
		}
	});

	it("delivers the line once, then stays silent", async () => {
		const env = setupTestEnvironment("pi-lens-3218-once-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			seedResolvedBlocker(runtime, cacheManager, env.tmpDir, target);

			const first = await runTurnEnd(runtime, cacheManager, env.tmpDir);
			expect(first).toContain("Resolved this turn: a.ts");

			// The next turn retires nothing new: the list was consumed, so the
			// line cannot re-serve (the criterion's "one delivery per
			// retirement, then silent").
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);
			const second = await runTurnEnd(runtime, cacheManager, env.tmpDir);
			expect(second).not.toContain("Resolved this turn");
			expect(resolvedBlockerFileCounts()).toEqual([1, 0]);
		} finally {
			env.cleanup();
		}
	});

	it("caps the lines at 10 files and counts the overflow", async () => {
		const env = setupTestEnvironment("pi-lens-3218-cap-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			for (let index = 0; index < 11; index += 1) {
				const file = path.join(env.tmpDir, `file-${index}.ts`);
				fs.writeFileSync(file, "const a = 1;\n");
				runtime.recordInlineBlockers(
					file,
					SUMMARY,
					index + 1,
					["lsp"],
					[1, 2],
					undefined,
					blockerDiagnostics(2),
				);
				runtime.clearInlineBlockers(file, index + 1);
			}
			const first = path.join(env.tmpDir, "file-0.ts");
			cacheManager.addModifiedRange(
				first,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);
			const later: string[] = [];
			while (runtime.hasResolvedBlockerFiles() && later.length < 10) {
				runtime.beginTurn();
				later.push(await runTurnEnd(runtime, cacheManager, env.tmpDir));
			}

			// At most four file lines per message (review-3776-r3 W1: the
			// section is a bounded share, never the whole cap); the ten the
			// coordinator kept arrive over later turn_ends, the eleventh is
			// the counted overflow.
			expect(content.match(/Resolved this turn:/g) ?? []).toHaveLength(4);
			expect(content).toContain("… and 1 more");
			expect(
				later.flatMap(
					(text) => text.match(/Resolved since the last report:/g) ?? [],
				),
			).toHaveLength(6);
			expect(resolvedBlockerFileCounts()).toEqual([4, 4, 2]);
			// The unit is named: `resolvedBlockerFiles` is the files LISTED, the
			// sibling field is the retire events past the cap (review-3776 F7).
			expect(turnEndMetadata("resolvedBlockerFilesDropped")).toEqual([1, 0, 0]);
		} finally {
			env.cleanup();
		}
	});

	it("does not claim a file resolved while it is blocking again this turn", async () => {
		const env = setupTestEnvironment("pi-lens-3218-reblock-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(target, "const a = 1;\n");
			runtime.bumpFileSeq(target);
			runtime.recordInlineBlockers(
				target,
				SUMMARY,
				1,
				["lsp"],
				[1, 2],
				undefined,
				blockerDiagnostics(2),
			);
			runtime.clearInlineBlockers(target, 2);
			// A later edit re-records the blocker; the current truth is blocking.
			runtime.recordInlineBlockers(
				target,
				SUMMARY,
				3,
				["lsp"],
				[1, 2],
				undefined,
				blockerDiagnostics(2),
			);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).not.toContain("Resolved this turn");
			expect(content).toContain("Unresolved from this turn");
		} finally {
			env.cleanup();
		}
	});

	it("delivers the line under lens-guard and keeps the record until it is consumed", async () => {
		// Recurrence (review-3776 F3): every round-1 case ran with lens-guard OFF,
		// so deleting `resolvedParts.length === 0 &&` from the no-blockers
		// clean-up left the whole suite green while the clean-up erased the
		// guard record (and the line) for lens-guard users.
		const env = setupTestEnvironment("pi-lens-3218-guard-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			seedResolvedBlocker(runtime, cacheManager, env.tmpDir, target);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir, true);

			expect(content).toContain(
				"Resolved this turn: a.ts (2 blocker(s) cleared by the 5th write)",
			);
		} finally {
			env.cleanup();
		}
	});

	it("renders the write ordinal with its irregular teens", async () => {
		// Recurrence (review-3776 F5): the 11-13 guard in `formatWriteOrdinal`
		// could be deleted with no red, shipping "11st", "12nd" and "13rd".
		const env = setupTestEnvironment("pi-lens-3218-ordinal-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(target, "const a = 1;\n");
			const cases: Array<[number, string]> = [
				[1, "1st"],
				[2, "2nd"],
				[3, "3rd"],
				[4, "4th"],
				[11, "11th"],
				[12, "12th"],
				[13, "13th"],
				[21, "21st"],
				[22, "22nd"],
			];
			for (const [index, ordinal] of cases) {
				runtime.recordInlineBlockers(
					target,
					SUMMARY,
					0,
					["lsp"],
					[1, 2],
					undefined,
					blockerDiagnostics(2),
				);
				runtime.clearInlineBlockers(target, index);
				cacheManager.addModifiedRange(
					target,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
					"session-3218",
				);
				const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);
				expect(content).toContain(`cleared by the ${ordinal} write)`);
				// Reset the write-order guard for the next case's lower record token.
				runtime.beginTurn();
			}
		} finally {
			env.cleanup();
		}
	});

	it("names no write when a legacy caller supplies no order", async () => {
		// Recurrence (review-3776 F5/M6): with no order token the retire fell
		// back to the RECORDING write's index, so the line said "cleared by the
		// 3rd write" about the write that created the blocker.
		const env = setupTestEnvironment("pi-lens-3218-legacy-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(target, "const a = 1;\n");
			runtime.recordInlineBlockers(
				target,
				SUMMARY,
				3,
				["lsp"],
				[1, 2],
				undefined,
				blockerDiagnostics(2),
			);
			expect(runtime.clearInlineBlockers(target)).toBe(true);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"session-3218",
			);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("Resolved this turn: a.ts (2 blocker(s))");
			expect(content).not.toContain("cleared by");
		} finally {
			env.cleanup();
		}
	});

	it("keeps the overflow tail with the files it describes", () => {
		// Recurrence (review-3776 F1 design): a batch that held every listed
		// file back must not deliver a bare "… and N more", and must not lose
		// the count the held files' own delivery will need.
		const env = setupTestEnvironment("pi-lens-3218-tail-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			for (let index = 0; index < 11; index += 1) {
				const file = path.join(env.tmpDir, `file-${index}.ts`);
				fs.writeFileSync(file, "const a = 1;\n");
				runtime.recordInlineBlockers(file, SUMMARY, 1, ["lsp"], [1, 2]);
				runtime.clearInlineBlockers(file, 2);
			}

			expect(runtime.consumeResolvedBlockerFiles(() => true)).toEqual({
				files: [],
				dropped: 0,
			});
			const delivered = runtime.consumeResolvedBlockerFiles(() => false);
			expect(delivered.files).toHaveLength(10);
			expect(delivered.dropped).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("takes the read-only early return when nothing was retired", async () => {
		// Recurrence guard for the read-only fall-through: a quiet turn (no
		// modified files, nothing retired) must still return before the
		// composer, which would emit a `turn_end` row and re-serve pending
		// blockers on every read-only turn.
		const env = setupTestEnvironment("pi-lens-3218-quiet-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

			expect(content).toBe("");
			expect(resolvedBlockerFileCounts()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("drops a resolved entry when the file is blocking again", () => {
		// Recurrence (review-3776 F1 design): a retained entry for a file that
		// blocks again must not linger and turn into a false claim once the new
		// record is later removed some other way.
		const env = setupTestEnvironment("pi-lens-3218-supersede-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			const target = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(target, "const a = 1;\n");
			runtime.recordInlineBlockers(target, SUMMARY, 1, ["lsp"], [1, 2]);
			runtime.clearInlineBlockers(target, 2);
			expect(runtime.hasResolvedBlockerFiles()).toBe(true);
			runtime.recordInlineBlockers(target, SUMMARY, 3, ["lsp"], [1, 2]);

			expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			expect(runtime.consumeResolvedBlockerFiles(() => false)).toEqual({
				files: [],
				dropped: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	describe("a retirement that lands during turn-end processing (review-3776 F1)", () => {
		// Recurrence: `consumeResolvedBlockerFiles` ran ~3300 lines after the
		// `unresolvedBlockers` snapshot. A retire in that window put the file in
		// the resolved list while the SAME message still told the agent the file
		// was unresolved; the filter then dropped the entry AND the consume
		// cleared it, so the agent kept a STOP block for a clean file forever.
		for (const lensGuard of [false, true]) {
			it(
				lensGuard
					? "carries a retirement that lands during turn-end processing under lens-guard"
					: "carries a retirement that lands during turn-end processing to the next turn_end",
				async () => {
					const env = setupTestEnvironment("pi-lens-3218-during-");
					try {
						const runtime = new RuntimeCoordinator();
						runtime.setTelemetryIdentity({ sessionId: "session-3218" });
						runtime.beginTurn();
						const cacheManager = new CacheManager(false);
						const target = path.join(env.tmpDir, "a.ts");
						fs.writeFileSync(target, "const a = 1;\nconst b = 2;\n");
						runtime.bumpFileSeq(target);
						runtime.recordInlineBlockers(
							target,
							SUMMARY,
							3,
							["lsp"],
							[1, 2],
							undefined,
							blockerDiagnostics(2),
						);
						cacheManager.addModifiedRange(
							target,
							{ start: 1, end: 1 },
							false,
							env.tmpDir,
							"session-3218",
						);
						// The retire lands after the turn_end snapshot of the unresolved
						// blockers: `consumeCascadeRuns` is awaited past it.
						const consumeCascadeRuns = runtime.consumeCascadeRuns.bind(runtime);
						const spy = vi
							.spyOn(runtime, "consumeCascadeRuns")
							.mockImplementation(() => {
								runtime.clearInlineBlockers(target, 9);
								return consumeCascadeRuns();
							});

						const first = await runTurnEnd(
							runtime,
							cacheManager,
							env.tmpDir,
							lensGuard,
						);
						spy.mockRestore();

						expect(first).toContain("Unresolved from this turn — a.ts");
						expect(first).not.toContain("Resolved");

						runtime.beginTurn();
						cacheManager.addModifiedRange(
							target,
							{ start: 1, end: 1 },
							false,
							env.tmpDir,
							"session-3218",
						);
						const second = await runTurnEnd(
							runtime,
							cacheManager,
							env.tmpDir,
							lensGuard,
						);

						expect(second).toContain(
							"Resolved since the last report: a.ts (2 blocker(s) cleared by the 9th write)",
						);
						expect(second).not.toContain("Unresolved");
						expect(second).not.toContain("Resolved this turn");
						expect(resolvedBlockerFileCounts()).toEqual([0, 1]);
					} finally {
						env.cleanup();
					}
				},
			);
		}
	});

	describe("turn_end paths that deliver nothing carry the entry (review-3776 F2)", () => {
		// Recurrence: the list was consumed only at the composer, so these two
		// early returns left the entry behind and a LATER turn rendered it as
		// "Resolved this turn" (probe P3: two turns stale, mislabelled).
		async function laterTurn(
			runtime: RuntimeCoordinator,
			cacheManager: CacheManager,
			cwd: string,
			target: string,
		): Promise<string> {
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				cwd,
				"session-3218",
			);
			return runTurnEnd(runtime, cacheManager, cwd);
		}

		it("carries an entry across a max-cycles turn_end", async () => {
			const env = setupTestEnvironment("pi-lens-3218-maxcycles-");
			try {
				const runtime = new RuntimeCoordinator();
				runtime.setTelemetryIdentity({ sessionId: "session-3218" });
				runtime.beginTurn();
				const cacheManager = new CacheManager(false);
				const target = path.join(env.tmpDir, "a.ts");
				seedResolvedBlocker(runtime, cacheManager, env.tmpDir, target);
				const state = cacheManager.readTurnState(env.tmpDir);
				state.turnCycles = state.maxCycles;
				cacheManager.writeTurnState(state, env.tmpDir);

				const first = await runTurnEnd(runtime, cacheManager, env.tmpDir);
				expect(first).toBe("");
				expect(resolvedBlockerFileCounts()).toEqual([]);

				const later = await laterTurn(
					runtime,
					cacheManager,
					env.tmpDir,
					target,
				);
				expect(later).toContain(
					"Resolved since the last report: a.ts (2 blocker(s) cleared by the 5th write)",
				);
				expect(later).not.toContain("Resolved this turn");
			} finally {
				env.cleanup();
			}
		});

		it("carries an entry across a foreign-owner turn_end", async () => {
			const env = setupTestEnvironment("pi-lens-3218-foreign-");
			const killSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true as never);
			try {
				const runtime = new RuntimeCoordinator();
				runtime.setTelemetryIdentity({ sessionId: "session-3218" });
				runtime.beginTurn();
				const cacheManager = new CacheManager(false);
				const target = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(target, "const a = 1;\nconst b = 2;\n");
				runtime.recordInlineBlockers(
					target,
					SUMMARY,
					3,
					["lsp"],
					[1, 2],
					undefined,
					blockerDiagnostics(2),
				);
				runtime.clearInlineBlockers(target, 5);
				cacheManager.addModifiedRange(
					target,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
					"mcp-foreign",
					"mcp",
				);
				const foreign = cacheManager.readTurnState(env.tmpDir);
				foreign.owner!.pid = process.pid + 1;
				cacheManager.writeTurnState(foreign, env.tmpDir);

				const first = await runTurnEnd(runtime, cacheManager, env.tmpDir);
				expect(first).toBe("");
				expect(resolvedBlockerFileCounts()).toEqual([]);

				killSpy.mockRestore();
				cacheManager.writeTurnState(
					{ files: {}, turnCycles: 0, maxCycles: 3, lastUpdated: "" },
					env.tmpDir,
				);
				const later = await laterTurn(
					runtime,
					cacheManager,
					env.tmpDir,
					target,
				);
				expect(later).toContain(
					"Resolved since the last report: a.ts (2 blocker(s) cleared by the 5th write)",
				);
				expect(later).not.toContain("Resolved this turn");
			} finally {
				killSpy.mockRestore();
				env.cleanup();
			}
		});
	});

	describe("the turn-end cap never swallows a consumed resolved line (review-3776-verify V1)", () => {
		// Recurrence (probe C1): the Resolved section rode LAST and
		// `capTurnEndMessage` (20 lines, then 1000 chars) cut it after
		// `consumeResolvedBlockerFiles` had already removed its entries, so a
		// retired file was never named and the agent kept its STOP block.

		/** One unresolved blocker whose rendered section is `rows` + 2 lines. */
		function recordUnresolvedBlocker(
			runtime: RuntimeCoordinator,
			cacheManager: CacheManager,
			cwd: string,
			name: string,
			rows = 5,
			pad = "",
		): void {
			const file = path.join(cwd, name);
			fs.writeFileSync(file, "const a = 1;\n".repeat(rows));
			runtime.bumpFileSeq(file);
			const body = Array.from(
				{ length: rows },
				(_, index) => `  L${index + 1}: blocker ${index}${pad}`,
			).join("\n");
			runtime.recordInlineBlockers(
				file,
				`🔴 STOP — ${rows} issue(s) must be fixed:\n${body}`,
				1,
				["lsp"],
				Array.from({ length: rows }, (_, index) => index + 1),
			);
			cacheManager.addModifiedRange(
				file,
				{ start: 1, end: 1 },
				false,
				cwd,
				"session-3218",
			);
		}

		/** Record and clear a blocker on `name` (2 blockers, the 2nd write). */
		function retire(runtime: RuntimeCoordinator, cwd: string, name: string) {
			const file = path.join(cwd, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "const a = 1;\n");
			runtime.recordInlineBlockers(file, SUMMARY, 1, ["lsp"], [1, 2]);
			expect(runtime.clearInlineBlockers(file, 2)).toBe(true);
		}

		const line = (name: string, label = "Resolved this turn") =>
			`${label}: ${name} (2 blocker(s) cleared by the 2nd write)`;

		/** End turns until nothing is pending (at most ten more); every message. */
		async function drain(
			runtime: RuntimeCoordinator,
			cacheManager: CacheManager,
			cwd: string,
		): Promise<string[]> {
			const messages = [await runTurnEnd(runtime, cacheManager, cwd)];
			while (runtime.hasResolvedBlockerFiles() && messages.length < 11) {
				runtime.beginTurn();
				messages.push(await runTurnEnd(runtime, cacheManager, cwd));
			}
			return messages;
		}

		/** A blocker section exactly as the turn-end block renders it. */
		const blockerSection = (name: string, rows: number, pad = "") =>
			[
				`Unresolved from this turn — ${name}:`,
				`🔴 STOP — ${rows} issue(s) must be fixed:`,
				...Array.from(
					{ length: rows },
					(_, index) => `  L${index + 1}: blocker ${index}${pad}`,
				),
			].join("\n");

		function newTurn() {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "session-3218" });
			runtime.beginTurn();
			return { runtime, cacheManager: new CacheManager(false) };
		}

		for (const lensGuard of [false, true]) {
			it(
				lensGuard
					? "keeps the resolved line when the cap truncates the unresolved detail under lens-guard"
					: "keeps the resolved line when the cap truncates the unresolved detail",
				async () => {
					logLatency.mockClear();
					const env = setupTestEnvironment("pi-lens-3218-c1-");
					try {
						const { runtime, cacheManager } = newTurn();
						const target = path.join(env.tmpDir, "a.ts");
						seedResolvedBlocker(runtime, cacheManager, env.tmpDir, target);
						for (let index = 0; index < 4; index += 1) {
							recordUnresolvedBlocker(
								runtime,
								cacheManager,
								env.tmpDir,
								`b${index}.ts`,
							);
						}

						const content = await runTurnEnd(
							runtime,
							cacheManager,
							env.tmpDir,
							lensGuard,
						);

						// The cap did fire: this is the V1 shape, not a message that fit.
						expect(content).toContain("... (truncated)");
						expect(content).toContain("Unresolved from this turn — b0.ts");
						expect(content).toContain(
							"Resolved this turn: a.ts (2 blocker(s) cleared by the 5th write)",
						);
						expect(runtime.hasResolvedBlockerFiles()).toBe(false);
						expect(resolvedBlockerFileCounts()).toEqual([1]);
					} finally {
						env.cleanup();
					}
				},
			);
		}

		it("keeps the overflow tail when the cap truncates the message", async () => {
			const env = setupTestEnvironment("pi-lens-3218-tailcap-");
			try {
				const { runtime, cacheManager } = newTurn();
				for (let index = 0; index < 11; index += 1) {
					retire(runtime, env.tmpDir, `file-${index}.ts`);
				}
				for (let index = 0; index < 4; index += 1) {
					recordUnresolvedBlocker(
						runtime,
						cacheManager,
						env.tmpDir,
						`b${index}.ts`,
					);
				}

				const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

				// The blockers alone pass the cap, so the section gets its floor:
				// one file line plus the tail, both whole; the rest wait.
				expect(content).toContain("... (truncated)");
				expect(content).toContain(`${line("file-0.ts")}\n… and 1 more\n\n`);
				expect(content).not.toContain("file-1.ts");
				expect(runtime.hasResolvedBlockerFiles()).toBe(true);
				expect(resolvedBlockerFileCounts()).toEqual([1]);
			} finally {
				env.cleanup();
			}
		});

		it("holds the resolved lines that do not fit the cap for the next turn_end", async () => {
			// Ten 165-char lines are ~1650 chars: the section alone passes the
			// 1000-char cap, so putting it first is not enough on its own.
			const env = setupTestEnvironment("pi-lens-3218-hold-");
			try {
				const { runtime, cacheManager } = newTurn();
				const names = Array.from(
					{ length: 11 },
					(_, index) =>
						`${String(index).padStart(2, "0")}-${"x".repeat(98)}.ts`,
				);
				for (const name of names) retire(runtime, env.tmpDir, name);
				cacheManager.addModifiedRange(
					path.join(env.tmpDir, names[0]!),
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
					"session-3218",
				);

				const [first, ...later] = await drain(
					runtime,
					cacheManager,
					env.tmpDir,
				);

				// Nothing any message consumed was cut by the cap.
				for (const message of [first!, ...later]) {
					expect(message).not.toContain("(truncated)");
				}
				expect(first).toContain("… and 1 more");
				const listedFirst = names
					.slice(0, 10)
					.filter((name) => first!.includes(line(name)));
				const listedLater = later.map((message) =>
					names
						.slice(0, 10)
						.filter((name) =>
							message.includes(line(name, "Resolved since the last report")),
						),
				);
				expect(listedFirst.length).toBeGreaterThan(0);
				expect(listedFirst.length).toBeLessThan(10);
				// Every one of the ten listed files is named exactly once, in order.
				expect([...listedFirst, ...listedLater.flat()]).toEqual(
					names.slice(0, 10),
				);
				expect(resolvedBlockerFileCounts()).toEqual([
					listedFirst.length,
					...listedLater.map((listed) => listed.length),
				]);
				expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		for (const over of [0, 1]) {
			it(
				over === 0
					? "fills the resolved budget exactly and holds nothing"
					: "holds the last resolved line one char over the budget",
				async () => {
					// With no blockers the budget is the section's 40% share of the
					// 1000-char cap, less room for the widest overflow tail, so the
					// tail can never be the part the cap cuts.
					const budget = 400 - "… and 9007199254740991 more".length;
					const env = setupTestEnvironment("pi-lens-3218-edge-");
					try {
						const { runtime, cacheManager } = newTurn();
						// Three lines whose `line.length + 1` sum to the budget exactly.
						const stems = [0, 1, 2].map((index) => `n${index}-`);
						const fixed = stems.reduce(
							(sum, stem) => sum + line(`${stem}.ts`).length + 1,
							0,
						);
						const pad = budget - fixed;
						const names = stems.map((stem, index) => {
							const share = Math.floor(pad / 3) + (index < pad % 3 ? 1 : 0);
							const extra = index === 2 ? over : 0;
							return `${stem}${"y".repeat(share + extra)}.ts`;
						});
						expect(
							names.reduce((sum, name) => sum + line(name).length + 1, 0),
						).toBe(budget + over);
						for (const name of names) retire(runtime, env.tmpDir, name);

						const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

						for (const name of names.slice(0, 2)) {
							expect(content).toContain(line(name));
						}
						expect(content.includes(line(names[2]!))).toBe(over === 0);
						expect(runtime.hasResolvedBlockerFiles()).toBe(over === 1);
						expect(resolvedBlockerFileCounts()).toEqual([3 - over]);
					} finally {
						env.cleanup();
					}
				},
			);
		}

		it("shortens a lone over-budget path with a middle ellipsis", async () => {
			// A hold for budget must still drain: were the first line held too,
			// a single long path would stay pending and every read-only turn
			// would fall through to the composer again. Taken whole, though, a
			// ~1000-char path let the cap cut the consumed line itself
			// (review-3776-r3 W2), so the path is shortened in the middle.
			const env = setupTestEnvironment("pi-lens-3218-long-");
			try {
				const { runtime, cacheManager } = newTurn();
				const name = [
					"d".repeat(250),
					"e".repeat(250),
					"f".repeat(250),
					`${"g".repeat(250)}.ts`,
				].join("/");
				retire(runtime, env.tmpDir, name);

				const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

				const resolved = content
					.split("\n")
					.find((text) => text.startsWith("Resolved this turn: "));
				// Both ends of the path survive around the `…`, and the clause
				// after the path is whole: nothing consumed was cut.
				expect(resolved).toMatch(
					/^Resolved this turn: d{20,}…g{20,}\.ts \(2 blocker\(s\) cleared by the 2nd write\)$/,
				);
				expect(resolved!.length).toBeLessThanOrEqual(400);
				expect(content).not.toContain("(truncated)");
				expect(runtime.hasResolvedBlockerFiles()).toBe(false);
				expect(resolvedBlockerFileCounts()).toEqual([1]);
			} finally {
				env.cleanup();
			}
		});

		it("does not split emoji when shortening paths or capping turn-end text", async () => {
			// Recurrence (review-3776-r4 probe M): raw UTF-16 slice offsets can
			// leave an unpaired surrogate in either turn-end rendering path.
			const env = setupTestEnvironment("pi-lens-3218-emoji-");
			try {
				const { runtime, cacheManager } = newTurn();
				const emojiPath = Array.from(
					{ length: 18 },
					(_, index) => `${"😀".repeat(9)}-${index}`,
				).join("/");
				retire(runtime, env.tmpDir, `${emojiPath}/file.ts`);
				const resolvedContent = await runTurnEnd(
					runtime,
					cacheManager,
					env.tmpDir,
				);

				expect(resolvedContent).toContain("…");
				expect(Buffer.from(resolvedContent).toString("utf8")).toBe(
					resolvedContent,
				);

				const capped = newTurn();
				recordUnresolvedBlocker(
					capped.runtime,
					capped.cacheManager,
					env.tmpDir,
					"emoji-blocker.ts",
					5,
					"😀".repeat(100),
				);
				const cappedContent = await runTurnEnd(
					capped.runtime,
					capped.cacheManager,
					env.tmpDir,
				);

				expect(cappedContent).toContain("(truncated)");
				expect(Buffer.from(cappedContent).toString("utf8")).toBe(cappedContent);
			} finally {
				env.cleanup();
			}
		});

		it("keeps all three blockers when ten files resolve", async () => {
			// Recurrence (review-3776-r3 W1, probe S1): the round-3 section took
			// ~973 of the 1000 chars, came first, and the cap left one truncated
			// blocker stub; blocked-1 and blocked-2 never reached the agent.
			const env = setupTestEnvironment("pi-lens-3218-s1-");
			try {
				const { runtime, cacheManager } = newTurn();
				for (let index = 0; index < 10; index += 1) {
					retire(
						runtime,
						env.tmpDir,
						`src/module-${index}/resolved-file-name.ts`,
					);
				}
				for (let index = 0; index < 3; index += 1) {
					recordUnresolvedBlocker(
						runtime,
						cacheManager,
						env.tmpDir,
						`blocked-${index}.ts`,
						3,
					);
				}

				const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

				expect(content).not.toContain("(truncated)");
				for (let index = 0; index < 3; index += 1) {
					expect(content).toContain(blockerSection(`blocked-${index}.ts`, 3));
				}
				expect(content).toContain("Resolved this turn: src/module-0/");
				expect(runtime.hasResolvedBlockerFiles()).toBe(true);
			} finally {
				env.cleanup();
			}
		});

		it("sizes the resolved lines to the chars the blockers leave", async () => {
			// One wide blocker (~700 chars, 5 lines) leaves under the 40% share,
			// so chars, not lines, bound the section.
			const env = setupTestEnvironment("pi-lens-3218-wide-");
			try {
				const { runtime, cacheManager } = newTurn();
				for (let index = 0; index < 10; index += 1) {
					retire(
						runtime,
						env.tmpDir,
						`src/module-${index}/resolved-file-name.ts`,
					);
				}
				const pad = ` ${"w".repeat(200)}`;
				recordUnresolvedBlocker(
					runtime,
					cacheManager,
					env.tmpDir,
					"wide.ts",
					3,
					pad,
				);

				const messages = await drain(runtime, cacheManager, env.tmpDir);

				expect(messages[0]).not.toContain("(truncated)");
				expect(messages[0]).toContain(blockerSection("wide.ts", 3, pad));
				expect(messages[0]).toContain("Resolved this turn: src/module-0/");
				// Each file is named once across the turn_ends that follow.
				for (let index = 0; index < 10; index += 1) {
					expect(
						messages.filter((text) => text.includes(`src/module-${index}/`)),
					).toHaveLength(1);
				}
				expect(runtime.hasResolvedBlockerFiles()).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		for (const over of [0, 1]) {
			it(
				over === 0
					? "fills exactly the chars the blockers leave"
					: "holds the last resolved line one char past what the blockers leave",
				async () => {
					// The blockers' share is their text plus the `\n\n` that joins
					// them to the section; the section gets the rest, less room for
					// the widest overflow tail.
					const pad = ` ${"w".repeat(200)}`;
					const blocker = blockerSection("wide.ts", 3, pad);
					const budget =
						1000 - (blocker.length + 2) - "… and 9007199254740991 more".length;
					const env = setupTestEnvironment("pi-lens-3218-wedge-");
					try {
						const { runtime, cacheManager } = newTurn();
						const stems = [0, 1, 2].map((index) => `w${index}-`);
						const fixed = stems.reduce(
							(sum, stem) => sum + line(`${stem}.ts`).length + 1,
							0,
						);
						const room = budget - fixed;
						const names = stems.map((stem, index) => {
							const share = Math.floor(room / 3) + (index < room % 3 ? 1 : 0);
							const extra = index === 2 ? over : 0;
							return `${stem}${"z".repeat(share + extra)}.ts`;
						});
						expect(
							names.reduce((sum, name) => sum + line(name).length + 1, 0),
						).toBe(budget + over);
						for (const name of names) retire(runtime, env.tmpDir, name);
						recordUnresolvedBlocker(
							runtime,
							cacheManager,
							env.tmpDir,
							"wide.ts",
							3,
							pad,
						);

						const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

						expect(content).not.toContain("(truncated)");
						expect(content).toContain(blocker);
						expect(content.includes(line(names[2]!))).toBe(over === 0);
						expect(runtime.hasResolvedBlockerFiles()).toBe(over === 1);
					} finally {
						env.cleanup();
					}
				},
			);
		}

		it("sizes the resolved lines to the lines the blockers leave", async () => {
			// Two short five-row blockers take 15 of the 20 lines (plus the
			// blank that joins them to the section), so lines, not chars, bound
			// it, and the overflow tail needs its own line.
			const env = setupTestEnvironment("pi-lens-3218-tall-");
			try {
				const { runtime, cacheManager } = newTurn();
				for (let index = 0; index < 11; index += 1) {
					retire(runtime, env.tmpDir, `file-${index}.ts`);
				}
				for (const name of ["tall-0.ts", "tall-1.ts"]) {
					recordUnresolvedBlocker(runtime, cacheManager, env.tmpDir, name, 5);
				}

				const content = await runTurnEnd(runtime, cacheManager, env.tmpDir);

				expect(content).not.toContain("(truncated)");
				expect(content).toContain(blockerSection("tall-0.ts", 5));
				expect(content).toContain(blockerSection("tall-1.ts", 5));
				expect(content).toContain(`${line("file-0.ts")}\n`);
				expect(content).toContain("… and 1 more");
				expect(runtime.hasResolvedBlockerFiles()).toBe(true);
			} finally {
				env.cleanup();
			}
		});
	});
});
