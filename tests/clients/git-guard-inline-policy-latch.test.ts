/**
 * #3248 remainder 2 — the git-guard commit gate honors the turn-end
 * disposition policy.
 *
 * The reported defect (reviewer probe on #3248, and on PR #3249): the agent
 * marks every blocker on a file `false-positive`, turn end renders no
 * `Unresolved from this turn` section and no `🔴 STOP` — and `lens-guard`
 * still blocks the commit, quoting the marked blocker back as the reason.
 * `updateGitGuardStatus` (`clients/runtime-coordinator.ts:488`) latches from
 * `hasBlockers || getInlineBlockersSnapshot().length > 0`, the turn-end policy
 * (#3246) wrote neither the latch nor the persisted record, and
 * `evaluateGitGuard` reads the LATCH first and short-circuits before the
 * record. Banner and guard disagreed.
 *
 * Every case drives the REAL seams: the in-process `RuntimeCoordinator` and
 * `CacheManager`, the durable `markDisposition` store on disk, the real
 * `handleTurnEnd`, the real `syncGitGuardRecord`/`evaluateGitGuard`, and
 * `consumeTurnEndFindings` — what the agent is shown and what the commit hook
 * decides, from one state. `editDispatch` below is the exact call sequence
 * `handleToolResult` makes (`clients/runtime-tool-result.ts:2526-2549`); the
 * pi host entry that calls it for real is witnessed by
 * `tests/index-4632-s4-tool-call-verdict.test.ts` (tier 2, the real pi session).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import {
	evaluateGitGuard,
	syncGitGuardRecord,
	type TurnEndFindingsCache,
} from "../../clients/git-guard.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const SESSION_ID = "git-guard-inline-policy-session";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

/** `--lens-guard` on: the flag the whole commit gate hangs off. */
function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: cwd,
		getFlag: (flag: string) => flag === "lens-guard",
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
		...overrides,
		// biome-ignore lint/suspicious/noExplicitAny: the dep surface is a dozen
		// client interfaces; these tests state only what they exercise.
	} as any;
}

/**
 * A blocking dispatch diagnostic, shaped as the runners emit it. `ast-grep`
 * rather than `lsp` for the same reason #3246's cases give: the freshness
 * sweep's dependency-drift axis only walks forward imports for an all-`lsp`
 * record, so this isolates the disposition axis from the import axis.
 */
function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
): Diagnostic {
	return {
		id: `ast-grep:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
	};
}

/**
 * The per-edit writer, exactly as `handleToolResult` runs it under
 * `--lens-guard` (`clients/runtime-tool-result.ts:2526-2549`): record the
 * blockers, write the latch from the dispatch verdict, resync the record.
 */
function editDispatch(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	filePath: string,
	diagnostics: Diagnostic[],
): void {
	const summary = formatDiagnostics(diagnostics, "blocking").trim();
	const bytes = fs.readFileSync(filePath);
	if (diagnostics.length > 0) {
		runtime.recordInlineBlockers(
			filePath,
			summary,
			runtime.nextWriteIndex(),
			[...new Set(diagnostics.map((d) => d.tool))],
			diagnostics
				.map((d) => d.line)
				.filter((line): line is number => typeof line === "number"),
			{
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			diagnostics,
		);
	} else {
		runtime.clearInlineBlockers(filePath);
	}
	runtime.updateGitGuardStatus(diagnostics.length > 0, summary);
	syncGitGuardRecord(runtime, cacheManager, cwd, filePath);
}

/** Mark a blocker `false-positive` through the real durable store. */
function markFalsePositive(cwd: string, diagnostic: Diagnostic): void {
	markDisposition(
		cwd,
		{
			cwd,
			filePath: diagnostic.filePath,
			tool: diagnostic.tool,
			rule: diagnostic.rule,
			message: diagnostic.message,
			line: diagnostic.line,
			content: fs.readFileSync(diagnostic.filePath, "utf8"),
		},
		"false-positive",
	);
}

/** Record a session `defer` for a diagnostic through the real owner. */
function markDefer(cwd: string, diagnostic: Diagnostic): void {
	markDisposition(
		cwd,
		{
			cwd,
			filePath: diagnostic.filePath,
			tool: diagnostic.tool,
			rule: diagnostic.rule,
			message: diagnostic.message,
			line: diagnostic.line,
		},
		"defer",
	);
}

function registerEdit(
	cacheManager: CacheManager,
	cwd: string,
	filePath: string,
): void {
	cacheManager.addModifiedRange(
		filePath,
		{ start: 1, end: 1 },
		false,
		cwd,
		SESSION_ID,
	);
}

/** What the agent actually reads at this turn end — "" when it says nothing. */
function turnEndText(
	cacheManager: CacheManager,
	cwd: string,
	runtime: RuntimeCoordinator,
): string {
	return (
		consumeTurnEndFindings(cacheManager, cwd, runtime)?.messages?.[0]
			?.content ?? ""
	);
}

function guardRecord(
	cacheManager: CacheManager,
	cwd: string,
): Partial<TurnEndFindingsCache> | undefined {
	return cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	)?.data;
}

function inlinePolicyRows(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === "inline_blocker_policy");
}

function newRuntime(): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
	return runtime;
}

afterEach(() => {
	cancelLSPIdleReset();
	resetDegradationLedger();
	_resetStateCacheForTests();
	// #4701 F1: a `defer` is process-scoped state in the owner until the
	// session boundary, so a case that records one must not hand it to the next
	// case (the cost guard reads it).
	_resetDeferredForTests();
	logLatency.mockClear();
	vi.useRealTimers();
});

describe("git-guard commit gate honors the turn-end disposition policy (#3248)", () => {
	it("clears the latch and the record when every blocker on the file is marked", async () => {
		const env = setupTestEnvironment("pi-lens-3248-all-marked-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\nbeta();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostics = [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
				blockingDiagnostic(filePath, 2, "beta is unsafe"),
			];
			editDispatch(runtime, cacheManager, cwd, filePath, diagnostics);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);

			for (const diagnostic of diagnostics) markFalsePositive(cwd, diagnostic);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			// The banner is silent …
			expect(turnEndText(cacheManager, cwd, runtime)).toBe("");
			// … and so is the gate: the latch it reads FIRST agrees with it.
			expect(runtime.gitGuardHasBlockers).toBe(false);
			expect(runtime.gitGuardSummary).toBe("");
			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toEqual({
				block: false,
			});
			// The persisted record is resynced in the same guard, not left
			// claiming a blocker for a later session or a later read to trip on.
			expect(guardRecord(cacheManager, cwd)?.hasBlockers ?? false).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("clears the latch and the record on a turn that only marked", async () => {
		// #4698: the same disposition, made on a turn that wrote NO file. The
		// policy pass that reconciles the latch sits below `handleTurnEnd`'s
		// `files.length === 0` early return, so before this case the mark took,
		// the banner said nothing, and the latch kept the marked record gating the
		// next commit. No `registerEdit` here: that is the whole point.
		const env = setupTestEnvironment("pi-lens-4698-mark-only-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\nbeta();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostics = [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
				blockingDiagnostic(filePath, 2, "beta is unsafe"),
			];
			editDispatch(runtime, cacheManager, cwd, filePath, diagnostics);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);
			for (const diagnostic of diagnostics) markFalsePositive(cwd, diagnostic);

			logLatency.mockClear();
			runtime.beginTurn();
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			// The gate the agent reaches next agrees with the mark …
			expect(runtime.gitGuardHasBlockers).toBe(false);
			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toEqual({
				block: false,
			});
			// … the record it would fall back on is gone too …
			expect(guardRecord(cacheManager, cwd)?.hasBlockers ?? false).toBe(false);
			// … and the turn left the ONE record a reader explains the flip with,
			// the same literal and the same fields the edit turn writes.
			const rows = inlinePolicyRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toMatchObject({
				records: 1,
				candidates: 2,
				dispositionSuppressed: 2,
				guardFilesSuppressed: 1,
				guardLatchCleared: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("keeps the gate closed when only two of four blockers are marked", async () => {
		const env = setupTestEnvironment("pi-lens-3248-two-of-four-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "pay.ts");
			fs.writeFileSync(filePath, "one();\ntwo();\nthree();\nfour();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostics = [1, 2, 3, 4].map((line) =>
				blockingDiagnostic(filePath, line, `finding ${line}`),
			);
			editDispatch(runtime, cacheManager, cwd, filePath, diagnostics);
			markFalsePositive(cwd, diagnostics[0]);
			markFalsePositive(cwd, diagnostics[2]);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("L2: finding 2");
			expect(text).toContain("L4: finding 4");
			expect(text).not.toContain("finding 1");
			expect(runtime.gitGuardHasBlockers).toBe(true);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);
			const record = guardRecord(cacheManager, cwd);
			expect(record?.hasBlockers).toBe(true);
			expect(record?.blockerContent ?? "").toContain("finding 2");
			expect(record?.blockerContent ?? "").toContain("finding 4");
		} finally {
			env.cleanup();
		}
	});

	it("keeps a sibling file's live blocker gating when another file is fully marked", async () => {
		const env = setupTestEnvironment("pi-lens-3248-sibling-");
		try {
			const cwd = env.tmpDir;
			const marked = path.join(cwd, "marked.ts");
			const live = path.join(cwd, "live.ts");
			fs.writeFileSync(marked, "alpha();\n");
			fs.writeFileSync(live, "gamma();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const markedDiagnostic = blockingDiagnostic(marked, 1, "alpha is unsafe");
			const liveDiagnostic = blockingDiagnostic(live, 1, "gamma is unsafe");
			editDispatch(runtime, cacheManager, cwd, marked, [markedDiagnostic]);
			editDispatch(runtime, cacheManager, cwd, live, [liveDiagnostic]);
			markFalsePositive(cwd, markedDiagnostic);

			registerEdit(cacheManager, cwd, marked);
			registerEdit(cacheManager, cwd, live);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("gamma is unsafe");
			expect(text).not.toContain("alpha is unsafe");
			expect(runtime.gitGuardHasBlockers).toBe(true);
			expect(runtime.gitGuardSummary).toContain("gamma is unsafe");
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);
			expect(
				guardRecord(cacheManager, cwd)?.blockerContent ?? "",
			).not.toContain("alpha is unsafe");
		} finally {
			env.cleanup();
		}
	});

	it("keeps the gate closed for a DEMOTED blocker with no mark", async () => {
		// Decided from the existing retire semantics, not invented here:
		// demotion takes a record out of the authoritative CHANNEL, it is not a
		// resolution, and `clients/blocker-freshness.ts:89` pins that the commit
		// gate is unaffected by it. Since #4990 the demoted arm runs the same
		// policy stack, so the agent's own mark is the ONE thing that can take it
		// out of the gate (the next case). Without a mark the gate still counts
		// it.
		const env = setupTestEnvironment("pi-lens-3248-demoted-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "drifted.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			editDispatch(runtime, cacheManager, cwd, filePath, [diagnostic]);
			expect(runtime.markInlineBlockerStale(filePath, "dependency-drift")).toBe(
				true,
			);
			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(runtime.gitGuardHasBlockers).toBe(true);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("stays clear when the NEXT turn edits an unrelated clean file", async () => {
		// The per-edit writer re-derives the latch from the blocker map on every
		// dispatch. Without the verdict living on the record it re-derives, the
		// gate slams shut again on the first unrelated edit after the mark and
		// stays shut until the next turn end.
		const env = setupTestEnvironment("pi-lens-3248-unrelated-edit-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			const unrelated = path.join(cwd, "notes.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			fs.writeFileSync(unrelated, "export const note = 1;\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			editDispatch(runtime, cacheManager, cwd, filePath, [diagnostic]);
			markFalsePositive(cwd, diagnostic);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			turnEndText(cacheManager, cwd, runtime);
			expect(runtime.gitGuardHasBlockers).toBe(false);

			runtime.beginTurn();
			editDispatch(runtime, cacheManager, cwd, unrelated, []);

			expect(runtime.gitGuardHasBlockers).toBe(false);
			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("re-latches when a NEW blocker is dispatched on the same file after the mark", async () => {
		// #1198 write ordering: the newer verdict wins. A fresh dispatch replaces
		// the record the policy suppressed, so the suppression verdict dies with
		// the record it described — a new blocker is never pre-suppressed.
		const env = setupTestEnvironment("pi-lens-3248-new-blocker-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\nbeta();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const marked = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			editDispatch(runtime, cacheManager, cwd, filePath, [marked]);
			markFalsePositive(cwd, marked);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			turnEndText(cacheManager, cwd, runtime);
			expect(runtime.gitGuardHasBlockers).toBe(false);

			runtime.beginTurn();
			const fresh = blockingDiagnostic(filePath, 2, "beta is unsafe");
			editDispatch(runtime, cacheManager, cwd, filePath, [fresh]);

			expect(runtime.gitGuardHasBlockers).toBe(true);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);
			expect(guardRecord(cacheManager, cwd)?.blockerContent ?? "").toContain(
				"beta is unsafe",
			);
		} finally {
			env.cleanup();
		}
	});

	it("records the latch flip once for the turn that clears the gate", async () => {
		const env = setupTestEnvironment("pi-lens-3248-observability-flip-");
		try {
			const cwd = env.tmpDir;
			const allMarked = path.join(cwd, "all.ts");
			fs.writeFileSync(allMarked, "alpha();\nbeta();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostics = [
				blockingDiagnostic(allMarked, 1, "alpha is unsafe"),
				blockingDiagnostic(allMarked, 2, "beta is unsafe"),
			];
			editDispatch(runtime, cacheManager, cwd, allMarked, diagnostics);
			for (const diagnostic of diagnostics) markFalsePositive(cwd, diagnostic);

			registerEdit(cacheManager, cwd, allMarked);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			turnEndText(cacheManager, cwd, runtime);

			// ONE bounded row for the whole turn — two findings, one record.
			const rows = inlinePolicyRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toMatchObject({
				dispositionSuppressed: 2,
				guardFilesSuppressed: 1,
				guardLatchCleared: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("records no latch flip on a turn whose file keeps a survivor", async () => {
		const env = setupTestEnvironment("pi-lens-3248-observability-kept-");
		try {
			const cwd = env.tmpDir;
			const partly = path.join(cwd, "partly.ts");
			fs.writeFileSync(partly, "one();\ntwo();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const pair = [
				blockingDiagnostic(partly, 1, "one is unsafe"),
				blockingDiagnostic(partly, 2, "two is unsafe"),
			];
			editDispatch(runtime, cacheManager, cwd, partly, pair);
			markFalsePositive(cwd, pair[0]);

			registerEdit(cacheManager, cwd, partly);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			turnEndText(cacheManager, cwd, runtime);

			const rows = inlinePolicyRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toMatchObject({
				dispositionSuppressed: 1,
				guardFilesSuppressed: 0,
				guardLatchCleared: false,
			});
			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("does not touch a latch this pass has no verdict about", async () => {
		// Scope pin for the recompute. The blocker map's snapshot drops entries
		// whose file no longer exists (#1245 `reconcileInlineBlockers`), so a
		// turn end can run with an EMPTY candidate set while the latch is still
		// set from the dispatch that raised the blocker. The policy suppressed
		// nothing and changed no verdict, so it must write nothing: re-deriving
		// the latch from a map that no longer represents that blocker would
		// open the gate on a turn that never judged it.
		const env = setupTestEnvironment("pi-lens-3248-no-verdict-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "gone.ts");
			const other = path.join(cwd, "other.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			fs.writeFileSync(other, "export const x = 1;\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			editDispatch(runtime, cacheManager, cwd, filePath, [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			]);
			expect(runtime.gitGuardHasBlockers).toBe(true);
			// Marked BEFORE the delete: a mark needs the bytes it anchors against.
			markFalsePositive(
				cwd,
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			);
			fs.rmSync(filePath);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);

			registerEdit(cacheManager, cwd, other);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(runtime.gitGuardHasBlockers).toBe(true);

			// #4698: the read-only turn shares the pin. The map holds no record for
			// the deleted file, so the quiet turn judges nothing — it must not
			// re-derive a latch whose population is gone, and writes no row.
			logLatency.mockClear();
			runtime.beginTurn();
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(inlinePolicyRows()).toHaveLength(0);
			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the gate closed when the suppressed file's bytes moved outside dispatch", async () => {
		// GG-3283-01, the reviewer's probe on PR #3283 round 1. A suppression
		// verdict is a statement about the bytes the policy read. When those
		// bytes move without entering pi-lens dispatch — an external formatter, a
		// `git checkout`, an editor write — nothing re-runs the policy, and
		// before this check the latch stayed clear, the durable record had been
		// cleared as clean, and the commit gate ALLOWED. The finding may well be
		// back and the mark's strict anchor no longer matches, so the honest
		// answer is "unknown", not "allowed".
		const env = setupTestEnvironment("pi-lens-3248-outside-dispatch-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			editDispatch(runtime, cacheManager, cwd, filePath, [diagnostic]);
			markFalsePositive(cwd, diagnostic);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			turnEndText(cacheManager, cwd, runtime);
			// The round-1 end state: latch clear, record gone, commit allowed.
			expect(runtime.gitGuardHasBlockers).toBe(false);
			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toEqual({
				block: false,
			});

			// No dispatch, no turn end: just different bytes on disk.
			fs.writeFileSync(filePath, "alpha();\nbeta();\n");

			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("still allows the commit after an unjudged turn end that changed nothing", async () => {
		// The other direction of the same rule, so the fix cannot become "any
		// turn end without a policy population re-blocks". A read-only turn takes
		// `handleTurnEnd`'s no-file early return (#4698 re-judges the latch there,
		// but only while the gate is CLOSED), and this gate is already open, so
		// the quiet turn judges nothing: the bytes the verdict was computed
		// against are still on disk, and the gate stays open.
		const env = setupTestEnvironment("pi-lens-3248-unjudged-turn-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			editDispatch(runtime, cacheManager, cwd, filePath, [diagnostic]);
			markFalsePositive(cwd, diagnostic);
			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			turnEndText(cacheManager, cwd, runtime);

			// A turn that touched no file at all: the early return, no fresh
			// population, and no work to do — this latch cannot be opened.
			logLatency.mockClear();
			runtime.beginTurn();
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(inlinePolicyRows()).toHaveLength(0);
			expect(runtime.gitGuardHasBlockers).toBe(false);
			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("judges nothing on a quiet turn when --lens-guard is off", async () => {
		// The read-only re-judge (#4698) exists for ONE reader: `evaluateGitGuard`.
		// With the flag off nothing consults the latch, so a quiet turn must not
		// pay for a policy pass whose verdict nobody reads — the state of a
		// project that never enabled the gate.
		const env = setupTestEnvironment("pi-lens-4698-flag-off-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			editDispatch(runtime, cacheManager, cwd, filePath, [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			]);
			// Marked, so the store is non-empty and only the FLAG can stop the pass.
			markFalsePositive(
				cwd,
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			);

			logLatency.mockClear();
			runtime.beginTurn();
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, cwd, { getFlag: () => false }),
			);

			expect(inlinePolicyRows()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("judges nothing on a closed gate with no mark in the project", async () => {
		// #4698's pass reacts to a MARK: a file-less turn can change a survivor
		// only through one. The guard is load-bearing on cost as well as on
		// meaning — `applyInlineBlockerPolicy` pays `loadProjectRulePolicy` per
		// record — so a blocked but unmarked session must re-read nothing on a
		// quiet turn. Without it, every reply in that state runs the whole policy
		// pass over every live blocker.
		const env = setupTestEnvironment("pi-lens-4698-unmarked-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			editDispatch(runtime, cacheManager, cwd, filePath, [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			]);

			// No mark: the empty store is the population.
			logLatency.mockClear();
			runtime.beginTurn();
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(inlinePolicyRows()).toHaveLength(0);
			expect(runtime.gitGuardHasBlockers).toBe(true);
			// The next commit is still refused: the pass judged nothing.
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("judges nothing on a quiet turn when ANOTHER project holds the session defer", async () => {
		// #4701 review F1: the marks guard must answer for the PROJECT. Its defer
		// half read the process-wide anchor Set, so one `defer` recorded in any
		// project — in any session of the process's life — made every project
		// look marked, and a quiet turn here ran the whole policy pass for state
		// this project cannot act on. Measured through this seam as probe P4: p50
		// 11,976 µs and 17,520 µs over two runs, 1.00 `inline_blocker_policy` row
		// per turn, against 85.6 µs and 0 rows in the same shape with no defer
		// anywhere.
		const env = setupTestEnvironment("pi-lens-4698-project-marked-");
		const other = setupTestEnvironment("pi-lens-4698-foreign-mark-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			editDispatch(runtime, cacheManager, cwd, filePath, [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			]);

			// A SECOND project root (its own marker, its own disposition store)
			// defers a finding of its own. A defer writes no store entry, so this
			// project still holds no mark of any kind.
			const otherFile = path.join(other.tmpDir, "app.ts");
			fs.writeFileSync(otherFile, "alpha();\n");
			markDefer(
				other.tmpDir,
				blockingDiagnostic(otherFile, 1, "alpha is unsafe"),
			);

			logLatency.mockClear();
			runtime.beginTurn();
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(inlinePolicyRows()).toHaveLength(0);
			// The population is untouched here, so the gate stays shut: only the
			// READ was wrong, never the verdict.
			expect(runtime.gitGuardHasBlockers).toBe(true);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);
		} finally {
			env.cleanup();
			other.cleanup();
		}
	});

	it("opens the gate for a DEMOTED blocker whose every finding is marked on a quiet turn", async () => {
		// #4990 reverses #4698's rule for the demoted arm: the same policy stack
		// judges a demoted record on BOTH turn shapes, so a fully marked one
		// leaves the gate. #4698's invariant still holds — the two shapes must
		// agree on one state — but the shared rule now includes the demoted arm.
		const env = setupTestEnvironment("pi-lens-4698-demoted-mark-only-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "drifted.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			editDispatch(runtime, cacheManager, cwd, filePath, [diagnostic]);
			expect(runtime.markInlineBlockerStale(filePath, "dependency-drift")).toBe(
				true,
			);
			markFalsePositive(cwd, diagnostic);

			// A turn that writes nothing at all: the mark-only shape.
			runtime.beginTurn();
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(runtime.gitGuardHasBlockers).toBe(false);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the gate closed when a quiet turn marks only one of two blockers", async () => {
		// The read-only sibling of the "two of four" case above: the pass may open
		// the gate only for a file whose WHOLE blocker set the policy suppressed.
		// A survivor is still gating, and this is also the shape a quiet turn pays
		// the policy cost for — marks exist, so the store probe cannot skip it.
		const env = setupTestEnvironment("pi-lens-4698-partial-mark-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\nbeta();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const pair = [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
				blockingDiagnostic(filePath, 2, "beta is unsafe"),
			];
			editDispatch(runtime, cacheManager, cwd, filePath, pair);
			markFalsePositive(cwd, pair[0]);

			runtime.beginTurn();
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(runtime.gitGuardHasBlockers).toBe(true);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the gate closed for a suppressed record with no content baseline", async () => {
		// Fail closed on unverifiable provenance, the rule the retire path
		// already applies: a record whose dispatch could not read the file
		// (`inlineBlockerFileContent` absent, `clients/pipeline.ts:1632`) carries
		// nothing that can confirm the verdict still describes current bytes, so
		// it must not be the reason a commit is allowed.
		const env = setupTestEnvironment("pi-lens-3248-no-baseline-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			// Recorded exactly as `handleToolResult` records it when the pipeline
			// had no readable content to fingerprint: no `contentBaseline`.
			runtime.recordInlineBlockers(
				filePath,
				formatDiagnostics([diagnostic], "blocking").trim(),
				runtime.nextWriteIndex(),
				["ast-grep"],
				[1],
				undefined,
				[diagnostic],
			);
			runtime.updateGitGuardStatus(true, "blocker");
			syncGitGuardRecord(runtime, cacheManager, cwd, filePath);
			markFalsePositive(cwd, diagnostic);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			turnEndText(cacheManager, cwd, runtime);

			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: a turn-end-written record stops gating once the file is FIXED", async () => {
		// The composer's own `blockerContent` shape, through the real
		// `handleTurnEnd`: `Unresolved from this turn — <path>:` plus the rendered
		// body, persisted at `clients/runtime-turn.ts:4291`. Then the agent FIXES
		// the finding — a clean dispatch, no disposition involved, which is what
		// makes this case independent of #3248 — and the commit gate must reopen.
		//
		// Pre-fix, the next `syncGitGuardRecord` read that record back, found no
		// line shaped `<path>: <text>`, and latched
		// `blocking_provenance_untrusted` for the rest of the session.
		const env = setupTestEnvironment("pi-lens-3282-turn-end-shape-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			editDispatch(runtime, cacheManager, cwd, filePath, [diagnostic]);
			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			// The record under test is the COMPOSER's, not the per-edit writer's.
			expect(guardRecord(cacheManager, cwd)?.blockerContent ?? "").toContain(
				"Unresolved from this turn — ",
			);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);

			// The agent fixes it: next turn's dispatch of the same file is clean.
			fs.writeFileSync(filePath, "safeAlpha();\n");
			editDispatch(runtime, cacheManager, cwd, filePath, []);

			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: a turn that also edited a clean file still reopens the gate", async () => {
		// The second cause, and the common shape: the composer persists
		// `blockingFiles: affectedFiles` (`clients/runtime-turn.ts:4292`) — EVERY
		// file the turn touched — while only the blocking file gets a
		// `Unresolved from this turn — …` section. A parse that demanded a
		// bijection between sections and `blockingFiles` therefore judged any
		// multi-file turn untrusted, and the session never recovered.
		const env = setupTestEnvironment("pi-lens-3282-clean-sibling-");
		try {
			const cwd = env.tmpDir;
			const blocking = path.join(cwd, "app.ts");
			const clean = path.join(cwd, "notes.ts");
			fs.writeFileSync(blocking, "alpha();\n");
			fs.writeFileSync(clean, "export const note = 1;\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			editDispatch(runtime, cacheManager, cwd, clean, []);
			editDispatch(runtime, cacheManager, cwd, blocking, [
				blockingDiagnostic(blocking, 1, "alpha is unsafe"),
			]);
			registerEdit(cacheManager, cwd, clean);
			registerEdit(cacheManager, cwd, blocking);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const persisted = guardRecord(cacheManager, cwd);
			expect(persisted?.blockingFiles ?? []).toHaveLength(2);
			expect(persisted?.blockerContent ?? "").not.toContain("notes.ts");
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);

			// The blocker is fixed; the clean sibling was never the gate's business.
			fs.writeFileSync(blocking, "safeAlpha();\n");
			editDispatch(runtime, cacheManager, cwd, blocking, []);

			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: the suppression notice in a section header is not read as a path", async () => {
		// `Unresolved from this turn — <path> (suppressed by disposition: 1
		// finding(s)):` (`clients/runtime-turn.ts:1085`) carries its own `": "`.
		// The per-edit attribution shape would take everything up to
		// `disposition` as the file name, so this header needs the composer's own
		// shape to be tried FIRST.
		const env = setupTestEnvironment("pi-lens-3282-suppressed-note-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "alpha();\nbeta();\n");

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostics = [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
				blockingDiagnostic(filePath, 2, "beta is unsafe"),
			];
			editDispatch(runtime, cacheManager, cwd, filePath, diagnostics);
			markFalsePositive(cwd, diagnostics[0]);
			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			expect(guardRecord(cacheManager, cwd)?.blockerContent ?? "").toContain(
				"(suppressed by disposition: 1 finding(s)):",
			);

			// The surviving blocker is then fixed too.
			fs.writeFileSync(filePath, "safeAlpha();\nsafeBeta();\n");
			editDispatch(runtime, cacheManager, cwd, filePath, []);

			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(evaluateGitGuard(runtime, cacheManager, cwd)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("leaves a 4.2.1-shaped record parseable and still blocking after the policy runs", async () => {
		// Old-record proof: this fix adds NO field to `TurnEndFindingsCache`, so
		// a record written by 4.2.1 is read by today's gate unchanged, and a
		// 4.2.1 commit hook reading a record written after a policy resync sees
		// only fields it already knows. The fixture is the 4.2.1 shape, byte for
		// byte, with only the paths substituted.
		const env = setupTestEnvironment("pi-lens-3248-old-record-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "legacy.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const fixture = JSON.parse(
				fs.readFileSync(
					path.join(
						import.meta.dirname,
						"../fixtures/git-guard-records/4.2.1-turn-end-findings.json",
					),
					"utf-8",
				),
			) as TurnEndFindingsCache;

			const runtime = newRuntime();
			runtime.projectRoot = cwd;
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			// Seed the map exactly as the 4.2.1 session that wrote the record did,
			// then hand the gate the 4.2.1 record itself.
			editDispatch(runtime, cacheManager, cwd, filePath, [diagnostic]);
			cacheManager.writeCache(
				"turn-end-findings",
				{
					...fixture,
					sessionId: SESSION_ID,
					affectedFiles: [filePath],
					blockingFiles: [filePath],
					fileSeqByPath: { [filePath]: runtime.getFileSeq(filePath) ?? 0 },
					projectSeqEnd: runtime.projectSeq,
				},
				cwd,
			);
			expect(evaluateGitGuard(runtime, cacheManager, cwd).block).toBe(true);

			// Unmarked: the policy keeps the blocker, and the old record survives
			// the turn end with every field it arrived with.
			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			expect(turnEndText(cacheManager, cwd, runtime)).toContain(
				"alpha is unsafe",
			);
			expect(runtime.gitGuardHasBlockers).toBe(true);
			const after = guardRecord(cacheManager, cwd) ?? {};
			expect(after.hasBlockers).toBe(true);
			// No field this fix invented reached the durable record: every key is
			// one `TurnEndFindingsCache` already carried at v4.2.1 (the interface
			// is byte-identical between `git show v4.2.1:clients/git-guard.ts` and
			// this tree), so a 4.2.1 commit hook reading a record written after a
			// policy pass sees only fields it already knows.
			const V4_2_1_KEYS = [
				"content",
				"hasBlockers",
				"affectedFiles",
				"sessionId",
				"projectSeqStart",
				"projectSeqEnd",
				"fileSeqByPath",
				"fileContentHashes",
				"affectedFilesTruncated",
				"blockingFiles",
				"consumed",
				"testFailures",
				"testFailureContent",
				"testFailureFiles",
				"blockerContent",
				"provenance",
			];
			// #4750 adds one: the owner's write stamp. The 4.2.1 reader
			// (`isTurnEndFindingsCache` at v4.2.1) checks named fields only, so an
			// extra key leaves the record a record to it.
			const V4750_KEYS = ["blockerWrittenAt"];
			// #4943 adds one: the session the composer addressed `content` to.
			// The same reader rule holds, and the gate never reads it.
			const V4943_KEYS = ["deliverTo"];
			// #5532 adds one: how `content` renders each blocker, which the request
			// that takes it counts. The same reader rule holds; the gate never reads it.
			const V5532_KEYS = ["blockerDeliveries"];
			expect(
				Object.keys(after).filter(
					(key) =>
						!V4_2_1_KEYS.includes(key) &&
						!V4750_KEYS.includes(key) &&
						!V4943_KEYS.includes(key) &&
						!V5532_KEYS.includes(key),
				),
			).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});
