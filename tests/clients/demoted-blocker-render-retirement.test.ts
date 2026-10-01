/**
 * Demoted-blocker body degradation and retirement (#1944).
 *
 * The past-EOF gate (#1641) moved a blocker whose file shrank past the cited
 * lines out of the authoritative channel and into the advisory channel. It
 * changed the CHANNEL and nothing else: the advisory embedded the blocker
 * body verbatim, so the agent still read "🔴 STOP — N issue(s) must be fixed"
 * with dead line numbers, and nothing ever retired the record, so it re-served
 * on every turn end for the life of the session (measured live at 80+ minutes,
 * session 01a0234c).
 *
 * Two independent behaviors, deliberately in separate tests so each guard is
 * mutation-proof on its own (#1944 AC4):
 *   - degradation: deleting `degradeDemotedFindingBody`'s call reds the body
 *     assertions.
 *   - retirement: deleting `retireDemotedPastEofBlocker`'s call reds the
 *     one-delivery assertions.
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
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	DEAD_LINE_ANNOTATION,
	degradeDemotedFindingBody,
	formatRetirementNote,
} from "../../clients/demoted-finding-render.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { _resetSharedLineCountCacheForTests } from "../../clients/diagnostic-line-freshness.js";
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

/** The exact body `formatDiagnostics(…, "blocking")` produces (format-utils.ts). */
const BLOCKER_SUMMARY = [
	"🔴 STOP — 2 issue(s) must be fixed:",
	"  L310: 'helperCache' is declared but its value is never read.",
	"    💡 Fix: remove the binding",
	"  L376: Unreachable code detected.",
].join("\n");

/**
 * A delta-promoted unused finding, exactly as `promoteDeltaUnusedToBlockers`
 * stamps it (#3218 criterion 1). Its rendered STOP body ends with the
 * seam-owned promotion note.
 */
const PROMOTED_UNUSED: Diagnostic = {
	id: "promoted-unused",
	message: "'tmpdir' is imported but never used",
	filePath: "a.ts",
	line: 12,
	severity: "hint",
	semantic: "none",
	tool: "lsp",
	promotionNote:
		"new in this edit → blocks in delta mode; pre-existing unused declarations only advise.",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
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

/** `advisorySections` from every `turn_end` tool_result emitted so far. */
function advisorySectionsPerTurn(): number[] {
	return logLatency.mock.calls
		.map((call) => call[0])
		.filter(
			(entry: any) =>
				entry?.type === "tool_result" && entry?.toolName === "turn_end",
		)
		.map((entry: any) => entry.metadata?.advisorySections ?? 0);
}

function retiredCountsPerTurn(): number[] {
	return logLatency.mock.calls
		.map((call) => call[0])
		.filter(
			(entry: any) =>
				entry?.type === "tool_result" && entry?.toolName === "turn_end",
		)
		.map((entry: any) => entry.metadata?.demotedFindingsRetired ?? 0);
}

beforeEach(() => {
	resetDegradationLedger();
});

afterEach(() => {
	cancelLSPIdleReset();
	logLatency.mockClear();
	_resetSharedLineCountCacheForTests();
	resetDegradationLedger();
});

describe("degradeDemotedFindingBody (#1944)", () => {
	it("strips the STOP banner and the must-be-fixed imperative", () => {
		const result = degradeDemotedFindingBody(BLOCKER_SUMMARY);
		expect(result.body).not.toContain("STOP");
		expect(result.body).not.toContain("must be fixed");
		expect(result.authorityMarkersRemoved).toBeGreaterThan(0);
		// Demote, never drop: the messages survive the degradation.
		expect(result.body).toContain("'helperCache' is declared");
		expect(result.body).toContain("Unreachable code detected.");
	});

	it("annotates only the cited lines the file no longer has", () => {
		const result = degradeDemotedFindingBody(BLOCKER_SUMMARY, {
			deadLines: [376],
		});
		expect(result.body).toContain(`L376 ${DEAD_LINE_ANNOTATION}`);
		expect(result.body).not.toContain(`L310 ${DEAD_LINE_ANNOTATION}`);
		expect(result.deadLinesAnnotated).toEqual([376]);
	});

	/**
	 * #1944 review F1. The rewrites used to run over the whole body, so a
	 * diagnostic's own words got edited: ts(2304) "Cannot find name 'STOP'"
	 * came out as "Cannot find name 'Previously flagged'". A finding's message
	 * is arbitrary text from an arbitrary runner and must survive verbatim.
	 */
	it("never rewrites a diagnostic's own words, only the banner", () => {
		const summary = [
			"🔴 STOP — 2 issue(s) must be fixed:",
			"  L12: Cannot find name 'STOP'.",
			"  L14: This layout must be fixed before the release.",
			"    💡 Fix: STOP using the deprecated helper",
		].join("\n");

		const result = degradeDemotedFindingBody(summary, { deadLines: [12] });
		const lines = result.body.split("\n");

		// The banner is degraded.
		expect(lines[0]).not.toContain("STOP");
		expect(lines[0]).not.toContain("must be fixed");
		// Every content line survives, token for token.
		expect(lines[1]).toBe(
			`  L12 ${DEAD_LINE_ANNOTATION}: Cannot find name 'STOP'.`,
		);
		expect(lines[2]).toBe(
			"  L14: This layout must be fixed before the release.",
		);
		expect(lines[3]).toBe("    💡 Fix: STOP using the deprecated helper");
		// Exactly one rewrite fired — the banner's.
		expect(result.authorityMarkersRemoved).toBe(1);
	});

	it("treats only the first line as banner when no cited row exists", () => {
		const summary = [
			"🔴 STOP — issues must be fixed:",
			"  package.json — outdated lockfile (STOP the build)",
		].join("\n");
		const result = degradeDemotedFindingBody(summary);
		const lines = result.body.split("\n");
		expect(lines[0]).not.toContain("STOP");
		expect(lines[1]).toBe(
			"  package.json — outdated lockfile (STOP the build)",
		);
	});

	/**
	 * #1944 verify round, Edge-D. `formatDiagnostics` opens its output with a
	 * newline, and it omits `L<n>` for a lineless diagnostic — so a body can
	 * reach here starting blank AND carrying no cited row. A naive "first line
	 * is the banner" rule degrades the empty string and leaves the real header
	 * at full authority. Production is saved from that today only by an
	 * undocumented `.trim()` one call upstream; this module claims to own the
	 * rule, so it must hold on its own input.
	 */
	it("skips leading blank lines when no cited row exists (Edge-D)", () => {
		const summary = [
			"",
			"🔴 STOP — 1 issue(s) must be fixed:",
			"  package.json — outdated lockfile (STOP the build)",
		].join("\n");
		const result = degradeDemotedFindingBody(summary);
		const lines = result.body.split("\n");
		expect(lines[0]).toBe("");
		// The real header is degraded even though it is not line zero.
		expect(lines[1]).not.toContain("STOP");
		expect(lines[1]).not.toContain("must be fixed");
		expect(result.authorityMarkersRemoved).toBe(1);
		// The content line below it still survives verbatim.
		expect(lines[2]).toBe(
			"  package.json — outdated lockfile (STOP the build)",
		);
	});

	it("drops a delta-promotion note from a demoted body (#3748 item 3)", () => {
		// Recurrence: PR #3744's STOP renderer appends the promotion rationale
		// AFTER the first cited row, which is the content region this module
		// deliberately never rewrites — so a demoted record still claimed it
		// blocked "new in this edit" after it had left the blocker channel.
		const summary = formatDiagnostics([PROMOTED_UNUSED], "blocking").trim();
		expect(summary).toContain("blocks in delta mode");

		const result = degradeDemotedFindingBody(summary, { deadLines: [12] });
		expect(result.body).not.toContain("blocks in delta mode");
		// Demote, never drop: the finding's own message survives.
		expect(result.body).toContain("'tmpdir' is imported but never used");
	});

	it("leaves a body with no authority vocabulary alone", () => {
		const plain = "  L4: something mild.";
		const result = degradeDemotedFindingBody(plain);
		expect(result.body).toBe(plain);
		expect(result.authorityMarkersRemoved).toBe(0);
	});
});

describe("turn-end demoted blocker (#1944)", () => {
	/**
	 * Set up a file that shrank past its cited lines, with the blocker record
	 * still in the store. Returns the target path.
	 */
	function seedShrunkBlocker(
		runtime: RuntimeCoordinator,
		tmpDir: string,
		summary = BLOCKER_SUMMARY,
	): string {
		const target = path.join(tmpDir, "provider-helper.ts");
		// 3 lines now; the record cites 310 and 376.
		fs.writeFileSync(target, "const a = 1;\nconst b = 2;\nexport { a, b };\n");
		runtime.bumpFileSeq(target);
		runtime.recordInlineBlockers(target, summary, 1, ["lsp"], [310, 376]);
		return target;
	}

	function markTurnModified(
		cacheManager: CacheManager,
		target: string,
		tmpDir: string,
		sessionId: string,
	): void {
		cacheManager.addModifiedRange(
			target,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			sessionId,
		);
	}

	it("degrades the demoted body: no STOP, no must-be-fixed, dead lines annotated", async () => {
		const env = setupTestEnvironment("pi-lens-1944-body-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-1944-body" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = seedShrunkBlocker(runtime, env.tmpDir);
			markTurnModified(cacheManager, target, env.tmpDir, "s-1944-body");

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("provider-helper.ts");
			expect(content).toContain("[stale — re-run to confirm]");
			// AC1 — the advisory carries neither authority marker.
			expect(content).not.toContain("STOP");
			expect(content).not.toContain("must be fixed");
			// AC1 — both cited lines are past EOF on a 3-line file.
			expect(content).toContain(`L310 ${DEAD_LINE_ANNOTATION}`);
			expect(content).toContain(`L376 ${DEAD_LINE_ANNOTATION}`);
			// Demote, never drop.
			expect(content).toContain("'helperCache' is declared");
		} finally {
			env.cleanup();
		}
	});

	it("retires after ONE demoted delivery instead of re-serving every turn", async () => {
		const env = setupTestEnvironment("pi-lens-1944-retire-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-1944-retire" });
			const cacheManager = new CacheManager(false);
			const target = seedShrunkBlocker(runtime, env.tmpDir);

			// Five consecutive edit turns. Pre-fix the record survives all five and
			// is re-served on each; the live session showed the re-serve is
			// unbounded, not capped at any particular number of turns.
			const TURNS = 5;
			const survivingAfterTurn: number[] = [];
			for (let turn = 0; turn < TURNS; turn += 1) {
				runtime.beginTurn();
				markTurnModified(cacheManager, target, env.tmpDir, "s-1944-retire");
				await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
				survivingAfterTurn.push(runtime.getInlineBlockersSnapshot().length);
			}

			// AC2 — served once, then gone. Pre-fix this reads [1,1,1,1,1].
			expect(survivingAfterTurn).toEqual([0, 0, 0, 0, 0]);
			// AC2 — exactly one turn delivered an advisory section.
			expect(advisorySectionsPerTurn()).toEqual([1, 0, 0, 0, 0]);
			// AC3 — the empty advisory sections are distinguishable: the turn that
			// dropped something says so, the four that had nothing to say do not.
			expect(retiredCountsPerTurn()).toEqual([1, 0, 0, 0, 0]);
		} finally {
			env.cleanup();
		}
	});

	it("names the suppression in the degradation ledger and in the payload", async () => {
		const env = setupTestEnvironment("pi-lens-1944-ledger-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-1944-ledger" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = seedShrunkBlocker(runtime, env.tmpDir);
			markTurnModified(cacheManager, target, env.tmpDir, "s-1944-ledger");

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			// AC3 — a bounded record naming the store, the file, the dropped lines,
			// and the reason.
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "demoted-finding-retired",
			);
			expect(group).toBeDefined();
			expect(group?.count).toBe(1);
			const entry = group?.latestReasons[0];
			expect(entry?.subject).toContain("inline-blocker:");
			expect(entry?.subject).toContain("provider-helper.ts");
			expect(entry?.reason).toContain("310");
			expect(entry?.reason).toContain("376");
			expect(entry?.reason).toContain("shrank past cited line");

			// AC3 — the payload itself says something was dropped, so an EMPTY
			// advisory section can only mean "nothing to say".
			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("Retired after this delivery");
			expect(content).toContain("will not be served again");

			// The retired payload must not survive as a suppression signature.
			expect(
				cacheManager.readCache("turn-end-findings-last", env.tmpDir),
			).toBeFalsy();
		} finally {
			env.cleanup();
		}
	});

	it("drops the promotion note from the delivered advisory (#3748 item 3)", async () => {
		const env = setupTestEnvironment("pi-lens-3748-note-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-3748-note" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const summary = formatDiagnostics([PROMOTED_UNUSED], "blocking").trim();
			const target = seedShrunkBlocker(runtime, env.tmpDir, summary);
			markTurnModified(cacheManager, target, env.tmpDir, "s-3748-note");

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).not.toContain("blocks in delta mode");
			// The finding survives under the advisory label.
			expect(content).toContain("'tmpdir' is imported but never used");
		} finally {
			env.cleanup();
		}
	});

	it("keeps the promotion note on a LIVE promoted STOP block (#3748 item 3)", async () => {
		// Recurrence guard for the drop above: the note is true of a live
		// blocker, so only the demotion seam may remove it. A drop applied in
		// `handleTurnEnd` for every row would strip the rationale from a block
		// that really does block in delta mode.
		const env = setupTestEnvironment("pi-lens-3748-live-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-3748-live" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const summary = formatDiagnostics([PROMOTED_UNUSED], "blocking").trim();
			const target = path.join(env.tmpDir, "live-promoted.ts");
			// Line 12 exists, so the past-EOF gate leaves the record live.
			fs.writeFileSync(
				target,
				`${Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n")}\n`,
			);
			runtime.bumpFileSeq(target);
			runtime.recordInlineBlockers(target, summary, 1, ["lsp"], [12]);
			markTurnModified(cacheManager, target, env.tmpDir, "s-3748-live");

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("Unresolved from this turn");
			expect(content).not.toContain("[stale — re-run to confirm]");
			expect(content).toContain("blocks in delta mode");
		} finally {
			env.cleanup();
		}
	});

	it("does not retire a dependency-drift demotion — its coordinates still exist", async () => {
		const env = setupTestEnvironment("pi-lens-1944-drift-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "s-1944-drift" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const target = path.join(env.tmpDir, "in-bounds.ts");
			fs.writeFileSync(
				target,
				"const a = 1;\nconst b = 2;\nexport { a, b };\n",
			);
			runtime.bumpFileSeq(target);
			runtime.recordInlineBlockers(target, BLOCKER_SUMMARY, 1, ["lsp"], [2]);
			// The drift gate's own demotion, on an IN-BOUNDS cited line.
			expect(runtime.markInlineBlockerStale(target, "dependency-drift")).toBe(
				true,
			);
			markTurnModified(cacheManager, target, env.tmpDir, "s-1944-drift");

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			// Still in the store: a re-run CAN confirm line 2, so #1419's
			// demote-not-drop rule stands for this gate.
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(retiredCountsPerTurn()).toEqual([0]);

			// It DOES get the body degradation — that half of the rule applies to
			// every demotion, whatever gate made it.
			const content =
				cacheManager.readCache<{ content: string }>(
					"turn-end-findings",
					env.tmpDir,
				)?.data?.content ?? "";
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).not.toContain("STOP");
			expect(content).not.toContain("must be fixed");
			// No dead lines to annotate: the cited coordinate is still in bounds.
			expect(content).not.toContain(DEAD_LINE_ANNOTATION);
			expect(content).not.toContain("Retired after this delivery");
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #1944 review F2. The integration tests above exercise only the ACCEPTING
 * path through `retireDemotedPastEofBlocker`, so each of its three rejection
 * guards was individually vacuous — deleting any one of them left the whole
 * file green. These four tests hit the method directly, one per guard, so a
 * deleted guard reds its own test and names itself in the failure.
 *
 * The `staleReason` guard is unreachable from today's only caller (the sweep
 * skips drift-demoted records before the delivery loop ever sees them). It
 * stays, and is tested, because it is the thing standing between a future
 * caller change and silently dropping a drift record whose coordinates the
 * agent can still act on.
 */
describe("retireDemotedPastEofBlocker guards (#1944)", () => {
	function seed(tmpDir: string): {
		runtime: RuntimeCoordinator;
		target: string;
	} {
		const runtime = new RuntimeCoordinator();
		const target = path.join(tmpDir, "guard.ts");
		fs.writeFileSync(target, "const a = 1;\n");
		runtime.recordInlineBlockers(target, BLOCKER_SUMMARY, 1, ["lsp"], [310]);
		return { runtime, target };
	}

	it("retires when every condition holds", () => {
		const env = setupTestEnvironment("pi-lens-1944-guard-ok-");
		try {
			const { runtime, target } = seed(env.tmpDir);
			expect(runtime.setInlineBlockerPastEofStale(target, true)).toBe(true);
			expect(runtime.retireDemotedPastEofBlocker(target, [310])).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("rejects an empty dead-line list — nothing proved the coordinates gone", () => {
		const env = setupTestEnvironment("pi-lens-1944-guard-lines-");
		try {
			const { runtime, target } = seed(env.tmpDir);
			runtime.setInlineBlockerPastEofStale(target, true);
			expect(runtime.retireDemotedPastEofBlocker(target, [])).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("rejects a record that is not demoted at all", () => {
		const env = setupTestEnvironment("pi-lens-1944-guard-live-");
		try {
			const { runtime, target } = seed(env.tmpDir);
			// Never demoted: a LIVE blocker must never be retired by this path.
			expect(runtime.getInlineBlockersSnapshot()[0]?.stale).toBeFalsy();
			expect(runtime.retireDemotedPastEofBlocker(target, [310])).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("rejects a dependency-drift demotion — its coordinates are still in bounds", () => {
		const env = setupTestEnvironment("pi-lens-1944-guard-drift-");
		try {
			const { runtime, target } = seed(env.tmpDir);
			expect(runtime.markInlineBlockerStale(target, "dependency-drift")).toBe(
				true,
			);
			expect(runtime.retireDemotedPastEofBlocker(target, [310])).toBe(false);
			const survivor = runtime.getInlineBlockersSnapshot()[0];
			expect(survivor?.staleReason).toBe("dependency-drift");
		} finally {
			env.cleanup();
		}
	});
});

describe("formatRetirementNote (#1944)", () => {
	it("names the dead lines", () => {
		expect(formatRetirementNote([310, 376])).toContain("lines 310, 376");
		expect(formatRetirementNote([9])).toContain("line 9");
	});
});
