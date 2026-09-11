/**
 * #2430 items 1, 3 and 4 — the observational net itself.
 *
 * Real files on real disk throughout: the whole mechanism is a content diff, so
 * a double that returns canned stats would prove nothing about whether the diff
 * can see a write (test-authoring screen "ambient-inspection double").
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	CLEAN_OBSERVATION_ARM_LIMIT,
	DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS,
	lookupLearnedMutatingTool,
	noteObservedMutation,
	resetMutationAttribution,
	shouldArmObservationForTool,
} from "../../clients/mutation-attribution.js";
import {
	_observedMutationStateForTests,
	_setObservedTurnBudgetForTests,
	armObservedMutation,
	deriveObservedEditRanges,
	type LineHashReadBudget,
	noteMutationHandled,
	type ObservedReplayEntry,
	OBSERVED_HANDLED_MAX,
	OBSERVED_SWEEP_HASH_BUDGET_BYTES,
	OBSERVED_SWEEP_STAT_WINDOW,
	OBSERVED_TARGET_DIR_MAX_ENTRIES,
	OBSERVED_TRACKED_MAX_FILES,
	OBSERVED_TURN_BUDGET_MS,
	refreshObservedMutationLedger,
	resetObservedMutationNet,
	runObservedSettledSweep,
	settleObservedMutation,
} from "../../clients/observed-mutation.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { lineContentHash } from "../../clients/read-guard.js";
import { setupTestEnvironment } from "./test-utils.js";

const SOURCE = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");

beforeEach(() => {
	resetObservedMutationNet();
	resetMutationAttribution();
	resetDegradationLedger();
});

function recorder(): {
	record: (entry: ObservedReplayEntry) => boolean;
	entries: ObservedReplayEntry[];
} {
	const entries: ObservedReplayEntry[] = [];
	return {
		entries,
		record: (entry) => {
			entries.push(entry);
			return true;
		},
	};
}

function armArgs(
	filePath: string,
	tmpDir: string,
	overrides: Partial<Parameters<typeof armObservedMutation>[0]> = {},
): Parameters<typeof armObservedMutation>[0] {
	return {
		toolCallId: "call-observed-1",
		toolName: "patch_file",
		targetPath: filePath,
		cwd: tmpDir,
		sessionGeneration: 1,
		turnIndex: 1,
		...overrides,
	};
}

describe("#2430 item 1 — arm, diff, replay", () => {
	it("sees a write by an unknown tool and replays it as an edit with real ranges", async () => {
		const env = setupTestEnvironment("pi-lens-2430-arm-");
		try {
			const filePath = path.join(env.tmpDir, "patched.ts");
			fs.writeFileSync(filePath, SOURCE);

			const armed = await armObservedMutation(armArgs(filePath, env.tmpDir));
			expect(armed).toMatchObject({ armed: true });

			// The unknown tool runs and changes line 2 only.
			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 22;", "const c = 3;", ""].join("\n"),
			);

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});

			expect(settled.settled).toBe(true);
			expect(settled.replayed).toBe(1);
			expect(sink.entries).toHaveLength(1);
			expect(sink.entries[0]).toMatchObject({
				kind: "edit",
				consumer: "patch_file",
				provenance: "observed",
				touchedLines: [2, 2],
			});
			expect(sink.entries[0].filePath.toLowerCase()).toContain("patched.ts");
		} finally {
			env.cleanup();
		}
	});

	it("keeps watching a provisionally attributed tool, and stops once the attribution is durable", async () => {
		// #2449 review round 2, F4/F2. ONE observation attributes the tool for
		// this session but does not make the claim durable, and the only thing
		// that can is a SECOND real disk diff — so the tool stays armed across
		// exactly one more call and then stops for good. The first cut latched
		// off after observation one, which is what made
		// `PERSIST_AFTER_OBSERVATIONS = 2` unreachable on the production path.
		const env = setupTestEnvironment("pi-lens-2430-attrib-");
		try {
			const filePath = path.join(env.tmpDir, "learned.ts");
			fs.writeFileSync(filePath, SOURCE);

			await armObservedMutation(armArgs(filePath, env.tmpDir));
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});

			// Provisional: attributed, still watched.
			expect(shouldArmObservationForTool("patch_file")).toBe(true);
			const second = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolCallId: "call-observed-2" }),
			);
			expect(second).toMatchObject({ armed: true });
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\nconst e = 5;\n`);
			await settleObservedMutation({
				toolCallId: "call-observed-2",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});

			// Durable: persisted, so nothing is ever armed for it again.
			expect(shouldArmObservationForTool("patch_file")).toBe(false);
			const third = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolCallId: "call-observed-3" }),
			);
			expect(third).toEqual({ armed: false, reason: "not-eligible" });
			expect(_observedMutationStateForTests().pending).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("reports no change, and no replay, when the tool wrote nothing", async () => {
		const env = setupTestEnvironment("pi-lens-2430-clean-");
		try {
			const filePath = path.join(env.tmpDir, "untouched.ts");
			fs.writeFileSync(filePath, SOURCE);
			await armObservedMutation(armArgs(filePath, env.tmpDir));

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});
			expect(settled).toMatchObject({ settled: true, replayed: 0 });
			expect(sink.entries).toEqual([]);
			// A clean observation is evidence too: it advances the arming latch.
			expect(shouldArmObservationForTool("patch_file")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("refuses to diff a baseline from a session that has since ended", async () => {
		const env = setupTestEnvironment("pi-lens-2430-gen-");
		try {
			const filePath = path.join(env.tmpDir, "gen.ts");
			fs.writeFileSync(filePath, SOURCE);
			await armObservedMutation(armArgs(filePath, env.tmpDir));
			fs.writeFileSync(filePath, `${SOURCE}const e = 5;\n`);

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 2,
				turnIndex: 1,
				record: sink.record,
			});
			expect(settled.reason).toBe("session-generation-advanced");
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2430 item 4 — bounds are visible, never silent", () => {
	it("declines the snapshot when the per-turn budget is spent and records a degradation", async () => {
		const env = setupTestEnvironment("pi-lens-2430-budget-");
		try {
			const filePath = path.join(env.tmpDir, "budgeted.ts");
			fs.writeFileSync(filePath, SOURCE);

			// Mutation proof for the budget: with the check removed this call
			// arms, `pending` is non-empty and no ledger entry exists.
			_setObservedTurnBudgetForTests(7, OBSERVED_TURN_BUDGET_MS + 1);
			const armed = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { turnIndex: 7 }),
			);

			expect(armed).toEqual({ armed: false, reason: "budget-exhausted" });
			expect(_observedMutationStateForTests().pending).toEqual([]);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "observed-mutation-budget",
			);
			expect(group?.latestReasons[0]?.subject).toBe("patch_file");
		} finally {
			env.cleanup();
		}
	});

	it("cancels cleanly on an aborted turn instead of finishing the walk", async () => {
		const env = setupTestEnvironment("pi-lens-2430-abort-");
		try {
			const filePath = path.join(env.tmpDir, "aborted.ts");
			fs.writeFileSync(filePath, SOURCE);

			const controller = new AbortController();
			controller.abort();
			const armed = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { signal: controller.signal }),
			);

			expect(armed).toEqual({ armed: false, reason: "aborted" });
			expect(_observedMutationStateForTests().pending).toEqual([]);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "observed-mutation-budget",
			);
			expect(group?.latestReasons[0]?.reason).toContain("aborted");
		} finally {
			env.cleanup();
		}
	});

	it("charges the per-turn budget so a busy turn cannot arm without limit", async () => {
		const env = setupTestEnvironment("pi-lens-2430-charge-");
		try {
			const filePath = path.join(env.tmpDir, "charged.ts");
			fs.writeFileSync(filePath, SOURCE);
			_setObservedTurnBudgetForTests(3, 0);
			await armObservedMutation(
				armArgs(filePath, env.tmpDir, { turnIndex: 3 }),
			);
			expect(
				_observedMutationStateForTests().turnSpentMs,
			).toBeGreaterThanOrEqual(0);
			// Same turn, so the spend accumulates rather than resetting.
			noteObservedMutation("other_tool", env.tmpDir);
			const before = _observedMutationStateForTests().turnSpentMs;
			await armObservedMutation(
				armArgs(filePath, env.tmpDir, {
					turnIndex: 3,
					toolName: "third_tool",
					toolCallId: "call-observed-3",
				}),
			);
			expect(
				_observedMutationStateForTests().turnSpentMs,
			).toBeGreaterThanOrEqual(before);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2430 item 3 — the agent_settled sweep", () => {
	it("catches drift in a previously-seen file that no tool call explains", async () => {
		const env = setupTestEnvironment("pi-lens-2430-sweep-");
		try {
			const filePath = path.join(env.tmpDir, "swept.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = () => [filePath];

			// First settle: the file is seen for the first time, so it seeds the
			// ledger and is deliberately NOT reported.
			const seed = recorder();
			const first = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: tracked,
				record: seed.record,
			});
			expect(first.drifted).toEqual([]);
			expect(seed.entries).toEqual([]);

			// A path-less tool changes it between turns.
			fs.writeFileSync(filePath, `${SOURCE}const f = 6;\n`);

			const sink = recorder();
			const second = await runObservedSettledSweep({
				turnIndex: 2,
				getTrackedPaths: tracked,
				record: sink.record,
			});
			expect(second.drifted).toHaveLength(1);
			expect(second.replayed).toBe(1);
			expect(sink.entries[0]).toMatchObject({
				kind: "edit",
				consumer: "settled-sweep",
				provenance: "settled-sweep",
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not re-report a file the pipeline already recorded this run", async () => {
		const env = setupTestEnvironment("pi-lens-2430-handled-");
		try {
			const filePath = path.join(env.tmpDir, "handled.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = () => [filePath];

			await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: tracked,
				record: recorder().record,
			});
			fs.writeFileSync(filePath, `${SOURCE}const g = 7;\n`);
			noteMutationHandled(filePath);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 2,
				getTrackedPaths: tracked,
				record: sink.record,
			});
			expect(swept.drifted).toEqual([]);
			expect(sink.entries).toEqual([]);
			// And the baseline moved on, so the same bytes are never reported later.
			const sinkAgain = recorder();
			const again = await runObservedSettledSweep({
				turnIndex: 3,
				getTrackedPaths: tracked,
				record: sinkAgain.record,
			});
			expect(again.drifted).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("re-baselines after the drain so pi-lens's own formatter output is not drift", async () => {
		const env = setupTestEnvironment("pi-lens-2430-refresh-");
		try {
			const filePath = path.join(env.tmpDir, "formatted.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = () => [filePath];

			await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: tracked,
				record: recorder().record,
			});
			// The deferred drain formats the file AFTER the sweep — and marks it
			// `handled`, exactly as the real drain does through
			// `recordMutationThroughSeam`. The refresh's traversal IS `handled`
			// now (#2449 review round 5, F2), so without this mark the refresh
			// would see nothing to re-baseline and the assertion below would be
			// testing an impossible state.
			fs.writeFileSync(filePath, SOURCE.replace("const a", "const  a"));
			noteMutationHandled(filePath);
			await refreshObservedMutationLedger({});

			const sink = recorder();
			const next = await runObservedSettledSweep({
				turnIndex: 2,
				getTrackedPaths: tracked,
				record: sink.record,
			});
			expect(next.drifted).toEqual([]);
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("never walks the workspace — it stats exactly the tracked set", async () => {
		const env = setupTestEnvironment("pi-lens-2430-nowalk-");
		try {
			const tracked = path.join(env.tmpDir, "tracked.ts");
			fs.writeFileSync(tracked, SOURCE);
			// A sibling the workspace walk would find and the tracked set will not.
			fs.writeFileSync(path.join(env.tmpDir, "sibling.ts"), SOURCE);

			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => [tracked],
				record: recorder().record,
			});
			expect(swept.scanned).toBe(1);
			expect(_observedMutationStateForTests().ledger).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("caps the tracked set it will stat", async () => {
		const env = setupTestEnvironment("pi-lens-2430-cap-");
		try {
			const files: string[] = [];
			for (let index = 0; index < 5; index += 1) {
				const filePath = path.join(env.tmpDir, `f${index}.ts`);
				fs.writeFileSync(filePath, SOURCE);
				files.push(filePath);
			}
			const oversized = [
				...files,
				...Array.from(
					{ length: OBSERVED_TRACKED_MAX_FILES + 50 },
					(_unused, index) => path.join(env.tmpDir, `ghost-${index}.ts`),
				),
			];
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => oversized,
				record: recorder().record,
			});
			// Two caps, both load-bearing. The tracked set is truncated to
			// OBSERVED_TRACKED_MAX_FILES, and ONE pass stats at most
			// OBSERVED_SWEEP_STAT_WINDOW of those before parking its cursor for
			// the next turn (#2449 review round 2, F3) — so `scanned` is the
			// window, not the set, and the rest is reported as `remaining`
			// rather than silently skipped.
			expect(swept.scanned).toBe(OBSERVED_SWEEP_STAT_WINDOW);
			expect(swept.notReachedThisPass).toBe(
				OBSERVED_TRACKED_MAX_FILES - OBSERVED_SWEEP_STAT_WINDOW,
			);
			expect(swept.cursor).toBe(OBSERVED_SWEEP_STAT_WINDOW);
			// Only the five files that exist can hold a baseline.
			expect(_observedMutationStateForTests().ledger).toHaveLength(5);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2430 — range derivation from stored line hashes", () => {
	it("names the changed lines, not the whole file", async () => {
		const env = setupTestEnvironment("pi-lens-2430-ranges-");
		try {
			const filePath = path.join(env.tmpDir, "ranged.ts");
			const lines = ["a", "b", "c", "d", "e"];
			fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
			const before: Record<number, string> = {};
			for (let index = 0; index < lines.length; index += 1) {
				before[index + 1] = lineContentHash(lines[index]);
			}
			// The read-guard's stored hashes cover a trailing empty line too.
			before[lines.length + 1] = lineContentHash("");

			fs.writeFileSync(filePath, `${["a", "B", "c", "D", "e"].join("\n")}\n`);
			expect(await deriveObservedEditRanges(filePath, before)).toEqual([
				[2, 2],
				[4, 4],
			]);
		} finally {
			env.cleanup();
		}
	});

	it("returns undefined with no baseline, so the caller over-approximates safely", async () => {
		expect(
			await deriveObservedEditRanges("/nonexistent/file.ts", undefined),
		).toBe(undefined);
	});
});

describe("#2430 — session boundary", () => {
	it("clears every container the net keeps", async () => {
		const env = setupTestEnvironment("pi-lens-2430-reset-");
		try {
			const filePath = path.join(env.tmpDir, "reset.ts");
			fs.writeFileSync(filePath, SOURCE);
			await armObservedMutation(armArgs(filePath, env.tmpDir));
			noteMutationHandled(filePath);
			expect(_observedMutationStateForTests().pending).toHaveLength(1);
			expect(_observedMutationStateForTests().handled).toHaveLength(1);

			resetObservedMutationNet();

			expect(_observedMutationStateForTests()).toMatchObject({
				pending: [],
				ledger: [],
				handled: [],
				turnSpentMs: 0,
			});
		} finally {
			env.cleanup();
		}
	});
});

describe("#2430 — the arming predicate is the hot-path gate", () => {
	it("does no filesystem work for a tool that is not eligible", async () => {
		const env = setupTestEnvironment("pi-lens-2430-hot-");
		try {
			const filePath = path.join(env.tmpDir, "hot.ts");
			fs.writeFileSync(filePath, SOURCE);
			// TWO observations: that is what makes the attribution durable, and
			// only a durable attribution stops the arming (#2449 round 2, F2).
			noteObservedMutation("already_known", env.tmpDir);
			noteObservedMutation("already_known", env.tmpDir);

			const statSpy = vi.spyOn(fs.promises, "stat");
			const armed = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolName: "already_known" }),
			);
			statSpy.mockRestore();

			// Mutation proof for the predicate: drop the eligibility check and this
			// count is the size of the directory walk plus the tracked set.
			expect(armed).toEqual({ armed: false, reason: "not-eligible" });
			expect(statSpy).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});

describe("#2449 review round 2 — the observation universe is the target path", () => {
	it("does not learn a tool from a SIBLING file that moved during the call", async () => {
		// F4. The first cut snapshotted the target's whole DIRECTORY, so an
		// unrelated write landing anywhere beside the file a READ-shaped tool
		// named was replayed as that tool's edit AND taught the attribution map
		// that the tool mutates. One coincidence, and every later call of a read
		// tool is classified as an edit for the rest of the session.
		const env = setupTestEnvironment("pi-lens-2449-sibling-");
		try {
			const target = path.join(env.tmpDir, "read-me.ts");
			const sibling = path.join(env.tmpDir, "written-by-someone-else.ts");
			fs.writeFileSync(target, SOURCE);
			fs.writeFileSync(sibling, SOURCE);

			const armed = await armObservedMutation(
				armArgs(target, env.tmpDir, { toolName: "sniff_file" }),
			);
			expect(armed).toMatchObject({ armed: true, scannedCount: 1 });

			// A background write during the call — a formatter, another agent, a
			// watcher. It touches the SIBLING, never the target.
			fs.writeFileSync(sibling, `${SOURCE}const intruder = 1;\n`);

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "sniff_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});

			expect(settled).toMatchObject({ settled: true, replayed: 0 });
			expect(sink.entries).toEqual([]);
			expect(lookupLearnedMutatingTool("sniff_file")).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("watches a DIRECTORY target's own entries, non-recursively", async () => {
		const env = setupTestEnvironment("pi-lens-2449-dir-");
		try {
			const dir = path.join(env.tmpDir, "pkg");
			const nested = path.join(dir, "deep");
			fs.mkdirSync(nested, { recursive: true });
			const inside = path.join(dir, "a.ts");
			const deeper = path.join(nested, "b.ts");
			fs.writeFileSync(inside, SOURCE);
			fs.writeFileSync(deeper, SOURCE);

			const armed = await armObservedMutation(
				armArgs(dir, env.tmpDir, { toolName: "codemod_dir" }),
			);
			// One entry: `a.ts`. `deep/` is a directory and `deep/b.ts` is a level
			// down, so neither is in the universe.
			expect(armed).toMatchObject({ armed: true, scannedCount: 1 });

			fs.writeFileSync(deeper, `${SOURCE}const nestedChange = 1;\n`);
			fs.writeFileSync(
				inside,
				["const a = 1;", "const b = 99;", "const c = 3;", ""].join("\n"),
			);

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "codemod_dir",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});
			expect(settled.replayed).toBe(1);
			expect(sink.entries).toHaveLength(1);
			expect(sink.entries[0].filePath.toLowerCase()).toContain("a.ts");
		} finally {
			env.cleanup();
		}
	});

	it("forgets a session attribution after three consecutive clean observations", async () => {
		// F4's de-attribution half: a claim made from one disk observation has
		// to be revisable by later evidence, or a coincidence is permanent.
		const env = setupTestEnvironment("pi-lens-2449-deattrib-");
		try {
			const filePath = path.join(env.tmpDir, "sometimes.ts");
			fs.writeFileSync(filePath, SOURCE);

			await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolName: "maybe_writes" }),
			);
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "maybe_writes",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});
			expect(lookupLearnedMutatingTool("maybe_writes")).toBe("session");

			for (
				let attempt = 0;
				attempt < DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS;
				attempt += 1
			) {
				const callId = `call-clean-${attempt}`;
				const armed = await armObservedMutation(
					armArgs(filePath, env.tmpDir, {
						toolName: "maybe_writes",
						toolCallId: callId,
					}),
				);
				expect(armed).toMatchObject({ armed: true });
				await settleObservedMutation({
					toolCallId: callId,
					toolName: "maybe_writes",
					sessionGeneration: 1,
					turnIndex: 1,
					record: recorder().record,
				});
			}

			expect(lookupLearnedMutatingTool("maybe_writes")).toBeUndefined();
			// Round 3, S4: forgetting resets BOTH counters. Leaving `clean` at
			// three while zeroing `mutating` put the tool in a state no evidence
			// could ever leave — `shouldArmObservationForTool` was false forever,
			// so the tool was never watched again and could never be RE-learned.
			// A de-attribution that cannot be undone is not a revision, it is a
			// terminal verdict reached from three no-ops.
			expect(shouldArmObservationForTool("maybe_writes")).toBe(true);

			// And a later REAL mutation re-learns it, end to end.
			await armObservedMutation(
				armArgs(filePath, env.tmpDir, {
					toolName: "maybe_writes",
					toolCallId: "call-relearn",
				}),
			);
			fs.writeFileSync(filePath, `${SOURCE}const relearned = 1;\n`);
			await settleObservedMutation({
				toolCallId: "call-relearn",
				toolName: "maybe_writes",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});
			expect(lookupLearnedMutatingTool("maybe_writes")).toBe("session");
		} finally {
			env.cleanup();
		}
	});

	it("does not forget on a clean run that an UNVERIFIABLE observation broke", async () => {
		// Round 3, S4's second half. De-attribution takes three CONSECUTIVE
		// clean observations. An observation the net could not complete is not a
		// clean one, so it breaks the run rather than counting toward it —
		// otherwise a truncated directory watch silently votes to un-learn a
		// tool it never actually watched.
		const env = setupTestEnvironment("pi-lens-2449-deattrib-gap-");
		try {
			const filePath = path.join(env.tmpDir, "mixed.ts");
			fs.writeFileSync(filePath, SOURCE);
			const wide = path.join(env.tmpDir, "wide");
			fs.mkdirSync(wide);
			for (
				let index = 0;
				index < OBSERVED_TARGET_DIR_MAX_ENTRIES + 20;
				index += 1
			) {
				fs.writeFileSync(
					path.join(wide, `f${String(index).padStart(3, "0")}.ts`),
					SOURCE,
				);
			}

			const cycle = async (callId: string, target: string): Promise<void> => {
				await armObservedMutation(
					armArgs(target, env.tmpDir, {
						toolName: "mixed_tool",
						toolCallId: callId,
					}),
				);
				await settleObservedMutation({
					toolCallId: callId,
					toolName: "mixed_tool",
					sessionGeneration: 1,
					turnIndex: 1,
					record: recorder().record,
				});
			};

			// One real mutation attributes the tool.
			await armObservedMutation(
				armArgs(filePath, env.tmpDir, {
					toolName: "mixed_tool",
					toolCallId: "call-mixed-seed",
				}),
			);
			fs.writeFileSync(filePath, `${SOURCE}const seeded = 1;\n`);
			await settleObservedMutation({
				toolCallId: "call-mixed-seed",
				toolName: "mixed_tool",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});
			expect(lookupLearnedMutatingTool("mixed_tool")).toBe("session");

			// Two clean observations, then one the net could not complete
			// (a directory wider than it may watch), then one more clean.
			await cycle("call-mixed-clean-0", filePath);
			await cycle("call-mixed-clean-1", filePath);
			await cycle("call-mixed-capped", wide);
			await cycle("call-mixed-clean-2", filePath);

			// Three cleans have now happened in total, but not three in a ROW.
			expect(lookupLearnedMutatingTool("mixed_tool")).toBe("session");
		} finally {
			env.cleanup();
		}
	});

	it("says so when a DIRECTORY target has more entries than it may watch", async () => {
		// Round 3, S3. Past OBSERVED_TARGET_DIR_MAX_ENTRIES the universe is a
		// TRUNCATION, and the first cut broke out of the loop silently: a codemod
		// that rewrote the 84th entry produced an empty diff, the empty diff was
		// scored as a CLEAN observation, and two of those latched the watching
		// off for the rest of the session — de-attributing a real codemod on
		// evidence the net never collected (catalog shape 10).
		const env = setupTestEnvironment("pi-lens-2449-dircap-");
		try {
			const dir = path.join(env.tmpDir, "wide");
			fs.mkdirSync(dir);
			const names = Array.from(
				{ length: OBSERVED_TARGET_DIR_MAX_ENTRIES + 20 },
				(_unused, index) => `f${String(index).padStart(3, "0")}.ts`,
			);
			for (const name of names) fs.writeFileSync(path.join(dir, name), SOURCE);
			const beyondCap = path.join(dir, names[names.length - 1]);

			for (let cycle = 0; cycle < CLEAN_OBSERVATION_ARM_LIMIT; cycle += 1) {
				const callId = `call-dircap-${cycle}`;
				const armed = await armObservedMutation(
					armArgs(dir, env.tmpDir, {
						toolName: "wide_codemod",
						toolCallId: callId,
					}),
				);
				expect(armed).toMatchObject({
					armed: true,
					scannedCount: OBSERVED_TARGET_DIR_MAX_ENTRIES,
				});

				// The change lands on an entry the truncated universe never saw.
				fs.writeFileSync(beyondCap, `${SOURCE}const cycle = ${cycle};\n`);

				const settled = await settleObservedMutation({
					toolCallId: callId,
					toolName: "wide_codemod",
					sessionGeneration: 1,
					turnIndex: 1,
					record: recorder().record,
				});
				expect(settled.changedPaths).toEqual([]);
				expect(settled.stoppedEarly).toBe(true);
				expect(settled.reason).toBe("target-dir-cap-exceeded");
			}

			expect(
				getDegradationSummary().some(
					(group) => group.kind === "observed-mutation-dir-cap",
				),
			).toBe(true);
			// An empty diff over a truncated universe is UNVERIFIABLE, so it must
			// not spend the tool's clean-observation budget.
			expect(shouldArmObservationForTool("wide_codemod")).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2449 review round 2 — the settle is not budget-gated", () => {
	it("completes for EVERY watched entry with the per-turn budget already spent", async () => {
		// F5. The first cut clamped the post-capture to whatever was left of the
		// arm budget (`Math.min(Math.max(remaining, 1), ...)`), so a busy turn
		// gave the settle 1ms, it reported a timeout, and a mutation that had
		// already been measured was dropped on the floor.
		//
		// Round 3, T2: the previous cut of this case watched ONE file, and the
		// capture always runs its FIRST entry by contract — so restoring the
		// clamp changed nothing and the case was vacuous. The target is now a
		// DIRECTORY whose entries all change, and the clock is a monotonic
		// 2ms-per-read stub so the clamped deadline (`max(remaining, 1)` = 1ms)
		// and the real one (50ms) separate deterministically instead of racing
		// the host's disk speed.
		const env = setupTestEnvironment("pi-lens-2449-settle-budget-");
		const realNow = Date.now.bind(Date);
		try {
			const dir = path.join(env.tmpDir, "late");
			fs.mkdirSync(dir);
			const names = ["a1.ts", "a2.ts", "a3.ts", "a4.ts", "a5.ts"];
			for (const name of names) fs.writeFileSync(path.join(dir, name), SOURCE);

			await armObservedMutation(
				armArgs(dir, env.tmpDir, { toolName: "codemod_dir" }),
			);

			// The rest of the turn burns the whole observational budget.
			_setObservedTurnBudgetForTests(1, OBSERVED_TURN_BUDGET_MS);

			for (const name of names) {
				fs.writeFileSync(
					path.join(dir, name),
					["const a = 1;", "const b = 42;", "const c = 3;", ""].join("\n"),
				);
			}

			let tick = realNow();
			vi.spyOn(Date, "now").mockImplementation(() => {
				tick += 2;
				return tick;
			});
			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "codemod_dir",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});
			vi.restoreAllMocks();

			expect(settled).toMatchObject({
				settled: true,
				replayed: names.length,
				scanned: names.length,
			});
			expect(settled.reason).toBeUndefined();
			expect(sink.entries).toHaveLength(names.length);
			// Every watched entry, not just the one the capture's first-entry rule
			// guarantees. A clamped settle replays exactly one of these.
			expect(
				sink.entries.every(
					(entry) =>
						entry.kind === "edit" &&
						entry.consumer === "codemod_dir" &&
						entry.provenance === "observed",
				),
			).toBe(true);
		} finally {
			vi.restoreAllMocks();
			env.cleanup();
		}
	});

	it("names a missing baseline instead of reporting a silent no-op", async () => {
		// F5's second half: "nothing changed" and "nothing was watched" are
		// different answers, and the record has to say which (catalog shape 10).
		const settled = await settleObservedMutation({
			toolCallId: "call-that-never-armed",
			toolName: "patch_file",
			sessionGeneration: 1,
			turnIndex: 1,
			record: recorder().record,
		});
		expect(settled).toMatchObject({
			settled: false,
			replayed: 0,
			reason: "no-pending-baseline",
		});
	});
});

describe("#2449 review round 2 — ranges are measured, never fabricated", () => {
	it("returns no ranges for a WINDOWED read-guard baseline", async () => {
		// F6. A partial read stores hashes for the lines it showed. The first cut
		// compared those by line number against the whole file: a real change at
		// line 3 fell below the window and was DROPPED, and every line past the
		// window's top was reported as new — the fabricated 61..101.
		const env = setupTestEnvironment("pi-lens-2449-window-");
		try {
			const filePath = path.join(env.tmpDir, "big.ts");
			const lines = Array.from(
				{ length: 100 },
				(_unused, index) => `const v${index} = ${index};`,
			);
			fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

			// A windowed baseline: only lines 61..101 were ever shown.
			//
			// Round 3, T3: the previous window (60..100) had 41 keys against a
			// 101-line split, so a coverage-BLIND implementation produced a
			// 100-long array and `deriveObservedEditRanges`' own size check
			// rejected it — the coverage check was never the thing under test and
			// gutting it left the case green. This window ends on the file's LAST
			// line, so the blind array is exactly 101 long, the size check passes,
			// and only the key-range check stands between the caller and a
			// fabricated 1..60 range over the window's own holes.
			const windowed: Record<number, string> = {};
			for (let line = 61; line <= 101; line += 1) {
				windowed[line] = lineContentHash(line === 101 ? "" : lines[line - 1]);
			}

			// The tool changes line 3 — inside the file, outside the window.
			lines[2] = "const v2 = 999;";
			fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

			expect(
				await deriveObservedEditRanges(filePath, windowed),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("returns no ranges when the line COUNT changed", async () => {
		// F6's other half: an insert shifts every following line, so a
		// by-line-number diff reports the shift rather than the edit. The safe
		// answer is no ranges at all, which over-approximates to the whole file.
		const env = setupTestEnvironment("pi-lens-2449-linecount-");
		try {
			const filePath = path.join(env.tmpDir, "grew.ts");
			fs.writeFileSync(filePath, SOURCE);
			const baseline = new Map(
				SOURCE.split("\n").map((line, index) => [
					index + 1,
					lineContentHash(line),
				]),
			);
			fs.writeFileSync(
				filePath,
				["const zero = 0;", ...SOURCE.split("\n")].join("\n"),
			);
			expect(
				await deriveObservedEditRanges(filePath, baseline),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("returns no ranges once the cumulative read budget is spent", async () => {
		// F8. Range derivation reads whole files; on the sweep that is once per
		// drifted file, which without a cumulative cap is unbounded read volume
		// at a turn boundary.
		const env = setupTestEnvironment("pi-lens-2449-rangebudget-");
		try {
			const filePath = path.join(env.tmpDir, "ranged.ts");
			fs.writeFileSync(filePath, SOURCE);
			const baseline = new Map(
				SOURCE.split("\n").map((line, index) => [
					index + 1,
					lineContentHash(line),
				]),
			);
			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 7;", "const c = 3;", ""].join("\n"),
			);

			const spent: LineHashReadBudget = { remainingBytes: 0 };
			expect(
				await deriveObservedEditRanges(filePath, baseline, spent),
			).toBeUndefined();

			const funded: LineHashReadBudget = { remainingBytes: 1024 * 1024 };
			expect(
				await deriveObservedEditRanges(filePath, baseline, funded),
			).toEqual([[2, 2]]);
			// The budget is actually DRAWN from, not merely consulted.
			expect(funded.remainingBytes).toBeLessThan(1024 * 1024);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2449 review round 2 — the settled sweep is incremental and honest", () => {
	it("covers a 400-file tracked set over several turns without ever timing out", async () => {
		// F3. At OBSERVED_TRACKED_MAX_FILES the first cut hashed every file on
		// every pass and blew the 200ms capture budget, so the sweep reported a
		// timeout and never ran at realistic sizes. Now it stats a window per
		// turn from a carried cursor and reads only what moved.
		const env = setupTestEnvironment("pi-lens-2449-incremental-");
		try {
			const tracked: string[] = [];
			for (let index = 0; index < OBSERVED_TRACKED_MAX_FILES; index += 1) {
				const filePath = path.join(env.tmpDir, `mod-${index}.ts`);
				fs.writeFileSync(filePath, SOURCE);
				tracked.push(filePath);
			}

			const turns = Math.ceil(
				OBSERVED_TRACKED_MAX_FILES / OBSERVED_SWEEP_STAT_WINDOW,
			);
			expect(turns).toBeGreaterThan(1);
			let covered = 0;
			for (let turn = 0; turn < turns; turn += 1) {
				const swept = await runObservedSettledSweep({
					turnIndex: turn,
					getTrackedPaths: () => tracked,
					record: recorder().record,
				});
				// Never a timeout, and the record always says how far it got, so a
				// partial pass can never be read as a complete one.
				expect(swept.reason).toBeUndefined();
				expect(swept.scanned).toBe(OBSERVED_SWEEP_STAT_WINDOW);
				expect(swept.scanned + swept.notReachedThisPass).toBe(
					OBSERVED_TRACKED_MAX_FILES,
				);
				expect(swept.cursor).toBeLessThan(OBSERVED_TRACKED_MAX_FILES);
				covered += swept.scanned;
				if (turn < turns - 1) {
					// Genuinely INCREMENTAL: one pass is not enough, which is the
					// whole reason the cursor exists.
					expect(_observedMutationStateForTests().ledger.length).toBeLessThan(
						OBSERVED_TRACKED_MAX_FILES,
					);
				}
			}
			expect(covered).toBeGreaterThanOrEqual(OBSERVED_TRACKED_MAX_FILES);
			// Coverage completes: every tracked file now holds a baseline.
			expect(_observedMutationStateForTests().ledger).toHaveLength(
				OBSERVED_TRACKED_MAX_FILES,
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not replay a file whose mtime moved but whose bytes did not", async () => {
		// F7. `touch` bumps mtime without moving a byte. The first cut fell back
		// to size+mtime whenever a hash was missing on either side and replayed
		// a phantom edit, queueing the file for a format it did not need.
		const env = setupTestEnvironment("pi-lens-2449-touch-");
		try {
			const filePath = path.join(env.tmpDir, "touched.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = [filePath];

			// Turn one seeds the baseline.
			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => tracked,
				record: recorder().record,
			});

			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(filePath, later, later);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => tracked,
				record: sink.record,
			});
			expect(swept.drifted).toEqual([]);
			expect(swept.unverifiable).toEqual([]);
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("rechecks an unchanged-stat file when its content hash is absent", async () => {
		// #2984 and the #2952 timing probe: a budgeted hash omission is missing
		// evidence. The observational net must fail open and look harder, even
		// when a rewrite preserves size and mtime.
		const env = setupTestEnvironment("pi-lens-2984-absent-hash-");
		try {
			const filePath = path.join(env.tmpDir, "large.ts");
			const content = Buffer.alloc(
				OBSERVED_SWEEP_HASH_BUDGET_BYTES + 1024,
				0x61,
			);
			fs.writeFileSync(filePath, content);
			const pinned = Math.floor(Date.now());
			fs.utimesSync(filePath, new Date(pinned), new Date(pinned));
			const baselineMtime = fs.statSync(filePath).mtimeMs;

			const armed = await armObservedMutation(armArgs(filePath, env.tmpDir));
			expect(armed.armed).toBe(true);
			fs.writeFileSync(filePath, content);
			fs.utimesSync(filePath, new Date(pinned), new Date(pinned));
			expect(fs.statSync(filePath).mtimeMs).toBe(baselineMtime);

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});

			expect(settled.changedPaths).toHaveLength(1);
			expect(settled.replayed).toBe(1);
			expect(sink.entries).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("names a file it cannot verify instead of replaying it on stat alone", async () => {
		// F7's honest-degradation half. A file past the sweep's read budget can
		// never carry a hash, so a stat that moves is un-provable either way —
		// and the answer is to say so, not to guess (catalog shape 10).
		const env = setupTestEnvironment("pi-lens-2449-unverifiable-");
		try {
			const filePath = path.join(env.tmpDir, "huge.bin");
			fs.writeFileSync(
				filePath,
				Buffer.alloc(OBSERVED_SWEEP_HASH_BUDGET_BYTES + 1024, 0x61),
			);
			const tracked = [filePath];

			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => tracked,
				record: recorder().record,
			});
			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(filePath, later, later);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => tracked,
				record: sink.record,
			});
			expect(swept.drifted).toEqual([]);
			expect(swept.unverifiable).toHaveLength(1);
			expect(swept.unverifiable[0].toLowerCase()).toContain("huge.bin");
			// Named, never replayed: a phantom format is worse than a gap that
			// reports itself.
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("catches a same-tick, same-SIZE rewrite that the stat short-circuit alone would miss", async () => {
		// Catalog shape 6, reached by the F3 redesign: "stat first, read only on
		// change" is what makes the sweep affordable, and a file rewritten to the
		// same length inside the same mtime tick we seeded it in has an identical
		// stat forever after — the drift would be baked into the baseline and
		// never reported. `LedgerEntry.seenAtMs` is the guard; delete it and this
		// case reports zero drift.
		const env = setupTestEnvironment("pi-lens-2449-sametick-");
		try {
			const filePath = path.join(env.tmpDir, "same-size.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = [filePath];
			// Pin the file's mtime to a whole millisecond BEFORE the baseline is
			// taken, so the restore below can reproduce the stat the ledger
			// recorded; without it the case silently stops testing the
			// short-circuit (round 3, T1).
			//
			// The reference value is what the FILESYSTEM stored, read back, never
			// the JS number handed to `utimesSync` (round 4, B1). On ext4 the stamp
			// is nanoseconds and `mtimeMs` is that count divided into a double, so
			// a whole-millisecond request comes back as 1788362498611.999 and the
			// round-trip assertion failed in CI on a filesystem this repo actually
			// runs on. The production guard was right either way: both the ledger
			// and the sweep compare `stat.mtimeMs` against `stat.mtimeMs`, so what
			// matters is that the two stats agree — which is exactly what this
			// pins.
			const pinned = Math.floor(Date.now());
			fs.utimesSync(filePath, new Date(pinned), new Date(pinned));
			const storedMtimeMs = fs.statSync(filePath).mtimeMs;

			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => tracked,
				record: recorder().record,
			});

			// Byte-for-byte the same LENGTH, written immediately — so on a coarse
			// filesystem clock both size and mtime can be unchanged.
			const rewritten = [
				"const a = 1;",
				"const b = 9;",
				"const c = 3;",
				"",
			].join("\n");
			expect(rewritten.length).toBe(SOURCE.length);
			fs.writeFileSync(filePath, rewritten);
			// Force the rewrite back onto the exact tick the LEDGER recorded. The
			// previous cut restored `statSync(file).mtimeMs` — the value the file
			// already had AFTER the rewrite — so `previous.mtimeMs !==
			// stat.mtimeMs`, the short-circuit was never reached, and deleting
			// the `seenAtMs` guard left this case green.
			fs.utimesSync(filePath, new Date(pinned), new Date(pinned));
			const restored = fs.statSync(filePath);
			expect(restored.size).toBe(SOURCE.length);
			expect(restored.mtimeMs).toBe(storedMtimeMs);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => tracked,
				record: sink.record,
			});
			expect(swept.drifted).toHaveLength(1);
			expect(sink.entries).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the handled set when the post-drain refresh could not finish", async () => {
		// Round 3, S5. `handled` is what stops pi-lens's OWN drain output from
		// being read as third-party drift on the next turn. The first cut cleared
		// it unconditionally, including on a refresh that aborted or timed out —
		// so the ledger still held the PRE-drain bytes while the only record that
		// those bytes were ours had just been thrown away, and the next settled
		// sweep replayed pi-lens's own formatter output as a third-party
		// mutation.
		const env = setupTestEnvironment("pi-lens-2449-refresh-abort-");
		try {
			const filePath = path.join(env.tmpDir, "own.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = [filePath];

			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => tracked,
				record: recorder().record,
			});

			// The deferred drain formats the file — pi-lens's own bytes.
			noteMutationHandled(filePath);
			fs.writeFileSync(filePath, `${SOURCE}const formatted = 1;\n`);

			const controller = new AbortController();
			controller.abort();
			await refreshObservedMutationLedger({
				turnIndex: 1,
				signal: controller.signal,
			});

			// The abort fired before the refresh reached the file, so its mark is
			// still standing (round 5, F2: the refresh's traversal is `handled`
			// itself now, so there is no separate "did it cover the tracked set"
			// question to report — the per-file retirement below is the whole
			// guarantee).
			expect(_observedMutationStateForTests().handled).toContain(
				normalizeMapKey(path.resolve(filePath)),
			);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => tracked,
				record: sink.record,
			});
			expect(swept.drifted).toEqual([]);
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("seeds a first sighting from the read-guard's stored hashes, with no file read", async () => {
		// F3's cost half: pi-lens already paid for those bytes on the read
		// (#505), so seeding the ledger from them means the sweep's first pass
		// over a file the agent has read costs one stat and nothing more.
		const env = setupTestEnvironment("pi-lens-2449-seed-");
		try {
			const filePath = path.join(env.tmpDir, "already-read.ts");
			fs.writeFileSync(filePath, SOURCE);
			const stored: Record<number, string> = {};
			SOURCE.split("\n").forEach((line, index) => {
				stored[index + 1] = lineContentHash(line);
			});

			const readSpy = vi.spyOn(fs.promises, "readFile");
			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => [filePath],
				getStoredLineHashes: () => stored,
				record: recorder().record,
			});
			expect(readSpy).not.toHaveBeenCalled();
			readSpy.mockRestore();

			// And the seeded baseline is real: a later content change is caught
			// against it, so the shortcut is not a coverage hole.
			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 5;", "const c = 3;", ""].join("\n"),
			);
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => [filePath],
				getStoredLineHashes: () => stored,
				record: recorder().record,
			});
			expect(swept.drifted).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2449 review round 4 — handled marks, bounds and budget honesty", () => {
	const sleep = (ms: number): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, ms));

	function budgetSubjects(): string[] {
		return getDegradationSummary()
			.filter((group) => group.kind === "observed-mutation-budget")
			.flatMap((group) => group.latestReasons.map((entry) => entry.subject));
	}

	it("retires every handled mark in ONE pass regardless of tracked-set size, so a third-party edit to a formerly-handled file is reported next sweep", async () => {
		// Round 5, F2 (reviewer PROBE-B1). The round-4 shape walked the FULL
		// tracked set on every post-drain refresh (`report: false` set
		// `window = total`, cursor pinned at 0), so a tracked set too large to
		// finish inside `OBSERVED_CAPTURE_BUDGET_MS` parked at the SAME prefix
		// every single turn — the cursor for `report: false` never advances —
		// and a mark past that prefix never retired. A third-party edit to that
		// file was suppressed forever, not just delayed.
		//
		// The fix makes the refresh's traversal `handled` itself: the files pi-
		// lens's own drain actually wrote this run, which is a HANDFUL
		// regardless of how large the tracked set is. This test proves the
		// bound (scans exactly the handled count, not the tracked count), the
		// completeness (every mark retires in the one call), and the payoff
		// (a formerly-handled file's next third-party edit is reported, not
		// suppressed) — all at a tracked-set size (400) large enough that the
		// OLD shape would have parked.
		const env = setupTestEnvironment("pi-lens-2449-refresh-scale-");
		try {
			const tracked: string[] = [];
			for (let index = 0; index < OBSERVED_TRACKED_MAX_FILES; index += 1) {
				const filePath = path.join(env.tmpDir, `tracked-${index}.ts`);
				fs.writeFileSync(filePath, SOURCE);
				tracked.push(filePath);
			}

			// Baseline every tracked file through the SETTLED SWEEP (the
			// `report: true` traversal, unaffected by this fix). Its window is
			// `OBSERVED_SWEEP_STAT_WINDOW` per call, so covering 400 files needs
			// at least `ceil(400 / window)` calls; the extra margin below is what
			// keeps this from flaking on a slow box without hard-coding a
			// magic attempt count untethered from the real geometry.
			const minPasses = Math.ceil(tracked.length / OBSERVED_SWEEP_STAT_WINDOW);
			for (
				let attempt = 0;
				attempt < minPasses + 20 &&
				_observedMutationStateForTests().ledger.length < tracked.length;
				attempt++
			) {
				await runObservedSettledSweep({
					turnIndex: attempt,
					getTrackedPaths: () => tracked,
					record: recorder().record,
				});
			}
			expect(_observedMutationStateForTests().ledger.length).toBe(
				tracked.length,
			);

			// pi-lens's own drain writes exactly THREE of the 400 — one at each
			// end of the tracked list and one in the middle — to prove position
			// is irrelevant to the refresh now.
			const handledFiles = [tracked[0], tracked[200], tracked[399]];
			for (const filePath of handledFiles) {
				noteMutationHandled(filePath);
				fs.writeFileSync(filePath, `${SOURCE}const formatted = 1;\n`);
			}
			resetDegradationLedger();

			// The mutation-testing hook (#2449 review round 5): an injected
			// per-stat delay. Three handled files at 2ms each is nothing (6ms),
			// so this must not budge the outcome. Reverting the fix to iterate
			// `getTrackedPaths()` instead of `handled` turns this into 400
			// stats * 2ms = 800ms against a 200ms budget, which parks the pass —
			// `scanned` would land far below 3 and the retirement/report
			// assertions below would fail. That is the red this test catches.
			const realStat = fs.promises.stat;
			const statSpy = vi
				.spyOn(fs.promises, "stat")
				.mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
					await sleep(2);
					return realStat(target);
				});
			const scanned = await refreshObservedMutationLedger({ turnIndex: 1 });
			statSpy.mockRestore();

			// The bound: exactly the handled set, never the tracked set.
			expect(scanned).toBe(handledFiles.length);
			// Never parked — nothing left for a coverage-gap record to report.
			expect(budgetSubjects()).not.toContain("post-drain-refresh");

			// Completeness: every mark retired in this ONE call, including the
			// one at tracked-399 that the old cursor-pinned-at-0 shape could
			// never reach.
			const marksAfter = _observedMutationStateForTests().handled;
			for (const filePath of handledFiles) {
				expect(marksAfter).not.toContain(
					normalizeMapKey(path.resolve(filePath)),
				);
			}

			// The payoff: a third-party edit to the FORMERLY-handled tail file
			// (tracked-399, deep past where the old shape ever parked) is
			// reported by the very next look, because its mark is actually
			// gone rather than standing forever.
			const tailFile = tracked[399];
			fs.writeFileSync(tailFile, `${SOURCE}const third_party = 2;\n`);
			const tailSink = recorder();
			await runObservedSettledSweep({
				turnIndex: 2,
				getTrackedPaths: () => [tailFile],
				record: tailSink.record,
			});
			expect(tailSink.entries).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	}, 30_000);

	it("names the handled mark it drops at the cap instead of dropping it silently", () => {
		// Round 4, S2, second half (the reviewer's PROBE-H). The cap is a real
		// bound and it must stay, but dropping a mark silently reinstates the
		// round-3 (S5) defect for that file: the ledger still holds the PRE-drain
		// bytes while the only record that those bytes were pi-lens's own is gone,
		// so the next settled sweep replays our own formatter output as
		// third-party drift. The replay is accepted; the SILENCE is not.
		const env = setupTestEnvironment("pi-lens-2449-handled-cap-");
		try {
			const victim = path.join(env.tmpDir, "victim-own-output.ts");
			noteMutationHandled(victim);
			expect(
				_observedMutationStateForTests().handled.some((key) =>
					key.includes("victim-own-output"),
				),
			).toBe(true);

			// Push the set past its cap. The victim was inserted first, so FIFO
			// order makes it the one dropped.
			for (let index = 0; index < OBSERVED_HANDLED_MAX; index += 1) {
				noteMutationHandled(path.join(env.tmpDir, `filler-${index}.ts`));
			}

			const marks = _observedMutationStateForTests().handled;
			expect(marks).toHaveLength(OBSERVED_HANDLED_MAX);
			expect(marks.some((key) => key.includes("victim-own-output"))).toBe(
				false,
			);

			// The record NAMES the victim. Identity is the dropped path, not a
			// constant label, so the ledger answers WHICH file will be re-reported
			// — a count alone would not (catalog shape 10).
			expect(
				budgetSubjects().some((subject) =>
					subject.includes("victim-own-output"),
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});
	it("charges the target line-hash read to the per-turn budget", async () => {
		// Round 4, S3. `captureLineHashes` reads and per-line-hashes the target,
		// up to OBSERVED_LINE_HASH_MAX_BYTES. It used to be awaited AFTER
		// `chargeTurnBudget`, so on a large target most of the arm's wall clock was
		// charged to nobody and OBSERVED_TURN_BUDGET_MS bounded far less work than
		// it claimed to.
		//
		// The delay is injected at `fs.promises.readFile` rather than inferred from
		// a large fixture, so the split is the same on any box: the stats capture
		// takes one read and the line-hash capture takes the other.
		const env = setupTestEnvironment("pi-lens-2449-charge-");
		try {
			const filePath = path.join(env.tmpDir, "charged.ts");
			fs.writeFileSync(filePath, SOURCE);
			_setObservedTurnBudgetForTests(7, 0);

			const realRead = fs.promises.readFile;
			const readSpy = vi
				.spyOn(fs.promises, "readFile")
				.mockImplementation(async (...args: Parameters<typeof realRead>) => {
					await sleep(40);
					return realRead(...args);
				});
			const startedAt = Date.now();
			const armed = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { turnIndex: 7 }),
			);
			const wallMs = Date.now() - startedAt;
			// Read the call count BEFORE restoring: mockRestore clears it.
			const readCalls = readSpy.mock.calls.length;
			readSpy.mockRestore();

			expect(armed.armed).toBe(true);
			// Both reads really happened — otherwise the delay proves nothing.
			expect(readCalls).toBeGreaterThanOrEqual(2);
			// Charged ≈ wall. Pre-fix the line-hash read (one whole 40ms delay) sat
			// outside the charge, so this gap was the size of a read.
			expect(
				_observedMutationStateForTests().turnSpentMs,
			).toBeGreaterThanOrEqual(wallMs - 10);
		} finally {
			env.cleanup();
		}
	});

	it("aborts an arm that is still inside the target line-hash read", async () => {
		// Round 4, S3, the other half of AGENTS.md's two-bounds rule. The step was
		// outside `withBounds` as well as outside the charge, so an abort raised
		// while it ran was simply not observed and the arm completed anyway.
		//
		// The abort is raised FROM the second read rather than on a timer, so the
		// test does not depend on how fast this box gets there.
		const env = setupTestEnvironment("pi-lens-2449-linehash-abort-");
		try {
			const filePath = path.join(env.tmpDir, "aborted.ts");
			fs.writeFileSync(filePath, SOURCE);
			_setObservedTurnBudgetForTests(8, 0);

			const controller = new AbortController();
			const realRead = fs.promises.readFile;
			let reads = 0;
			const readSpy = vi
				.spyOn(fs.promises, "readFile")
				.mockImplementation(async (...args: Parameters<typeof realRead>) => {
					reads += 1;
					// Read 1 is the stats capture; read 2 is the line-hash capture, so
					// by here the arm is inside the step under test.
					if (reads === 2) controller.abort();
					await sleep(10);
					return realRead(...args);
				});
			const armed = await armObservedMutation(
				armArgs(filePath, env.tmpDir, {
					turnIndex: 8,
					signal: controller.signal,
				}),
			);
			readSpy.mockRestore();

			expect(reads).toBeGreaterThanOrEqual(2);
			expect(armed.armed).toBe(false);
			// Narrowing for the discriminated result; the assertion above is the
			// one that fails first on pre-fix code.
			if (armed.armed) throw new Error("expected the arm to be aborted");
			expect(armed.reason).toBe("aborted");
			// And nothing was left armed for a settle that can never be honest.
			expect(_observedMutationStateForTests().pending).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});
