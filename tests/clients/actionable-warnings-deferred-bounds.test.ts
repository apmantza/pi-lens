/**
 * #2504 review round 2 — the DEFERRED off-hook actionable-warnings loop.
 *
 * #2504 moved the cold-cache LSP fresh-pull loop off the awaited `turn_end`
 * hook. Two defects came with it:
 *
 *  - F2. The deferred report is stamped with the ORIGINATING turn's
 *    `turnIndex`/`projectSeq` and may land up to 60 s (many turns) later,
 *    where it overwrote a NEWER report. `agent_end` then read that cache
 *    back, saw `project_seq_mismatch`, and silently skipped the autofix pass;
 *    `lens_diagnostics` re-served the same stale delta.
 *  - F3. The loop had effectively ONE bound. Its `signal` was the COMPLETED
 *    turn's `ctx.signal`, which `index.ts` clears from the ambient slot in its
 *    `finally` and which therefore never fires; the only live bound was a 60 s
 *    wall deadline checked BETWEEN files. A wedged `getDiagnostics` was
 *    unbounded, the loop kept opening files after `turn_end` returned and
 *    after the LSP idle reset, a `session_shutdown` mid-loop hit the #234
 *    spawn-at-teardown shape, and a second deferral simply overwrote the
 *    module-level handle, leaving the first loop running and unstoppable.
 *
 * The LSP SERVICE is faked here, but `resetLSPService` is the real one
 * (`importOriginal` below): the session_shutdown tests drive production's own
 * teardown entry point, not a stand-in for it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type { ActionableWarningsReport } from "../../clients/actionable-warnings.js";
import type { LSPCodeAction, LSPDiagnostic } from "../../clients/lsp/client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "./test-utils.js";

/** Basenames whose `getDiagnostics` never settles — a wedged server. */
let wedgedFiles = new Set<string>();
/**
 * Basenames whose `openFile` never settles (#2504 review round 3, F-B). A
 * server that never acknowledges `didOpen` is the #240 shape: the document
 * the next pull asks about was never received, so an empty pull answers
 * "unknown", not "clean".
 */
let wedgedOpens = new Set<string>();
/** What a FRESH pull returns, by basename. Default: nothing. */
let diagnosticsByFile = new Map<string, LSPDiagnostic[]>();
/** What `codeAction` returns. A record only survives if it has one. */
let codeActions: LSPCodeAction[] = [];
/**
 * How long a fresh pull takes (#2504 review round 5, F2). A real one is
 * ~880 ms; the defect was that 25 of them in one deferred loop all claimed
 * the SAME observation time, taken when the loop finished.
 */
let pullDelayMs = 0;
/** Wall-clock ms when each file's pull STARTED / RETURNED, by basename. */
let pullStartedAt = new Map<string, number>();
let pullReturnedAt = new Map<string, number>();

const openFile = vi.fn(async (filePath: string, _content?: string) => {
	if (wedgedOpens.has(path.basename(filePath))) {
		// Never settles: the server never acknowledges the document.
		await new Promise(() => {});
	}
	return undefined;
});
const getDiagnostics = vi.fn(async (filePath: string) => {
	const base = path.basename(filePath);
	if (wedgedFiles.has(base)) {
		// Never settles. Only a per-round-trip bound can get past this.
		await new Promise(() => {});
	}
	pullStartedAt.set(base, Date.now());
	if (pullDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, pullDelayMs));
	}
	pullReturnedAt.set(base, Date.now());
	return diagnosticsByFile.get(base) ?? [];
});
const codeAction = vi.fn(async (): Promise<LSPCodeAction[]> => codeActions);
/**
 * Basenames the LSP cache has already primed, and with what. Empty by default,
 * so every file is a cold fresh pull and the report DEFERS — which is what all
 * the cases below except the two-loop attribution one want. Priming even one
 * file flips the same report to the IN-BAND path (`primed.length === 0` is the
 * deferral's condition), which is how a single test can exercise both loops.
 */
let primedByFile = new Map<string, LSPDiagnostic[]>();
const getLastKnownDiagnostics = vi.fn((filePath: string) =>
	primedByFile.get(path.basename(filePath)),
);

// Factory-seeded (#2592): the deferred loop below runs inside
// `buildActionableWarningsReport`'s swallow-all catch, so a missing method is
// invisible here — it just blanks the report the bounds assertions read.
const fakeService = makeLspServiceDouble({
	supportsLSP: (filePath: string) => filePath.endsWith(".ts"),
	openFile,
	getDiagnostics,
	codeAction,
	getLastKnownDiagnostics,
});

vi.mock("../../clients/lsp/index.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/index.js")>();
	return { ...actual, getLSPService: () => fakeService };
});

/**
 * #2504 review round 7 (F3): `logActionableWarningsEvent` is a real no-op
 * under `isTestMode()`, which is exactly why a pre-merge-vs-merged-report
 * regression in its caller has no visible symptom without intercepting the
 * call itself. Mocked here (not spied) so the arguments reach a plain array
 * before the real implementation's test-mode short-circuit would swallow
 * them.
 */
const loggedActionableWarningsEvents = vi.hoisted(
	() => [] as Array<{ event: string; metadata?: Record<string, unknown> }>,
);
vi.mock("../../clients/actionable-warnings-logger.js", () => ({
	logActionableWarningsEvent: (entry: {
		event: string;
		metadata?: Record<string, unknown>;
	}) => {
		loggedActionableWarningsEvents.push(entry);
	},
	getActionableWarningsLogPath: () => "",
	flushActionableWarningsLog: async () => {},
}));

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2504-deferred-");
	wedgedFiles = new Set();
	wedgedOpens = new Set();
	primedByFile = new Map();
	diagnosticsByFile = new Map();
	codeActions = [];
	pullDelayMs = 0;
	pullStartedAt = new Map();
	pullReturnedAt = new Map();
	openFile.mockClear();
	getDiagnostics.mockClear();
	codeAction.mockClear();
	getLastKnownDiagnostics.mockClear();
	loggedActionableWarningsEvents.length = 0;
	resetDegradationLedger();
});

afterEach(async () => {
	// Slot isolation. A case that leaves a deferral in flight -- a FAILING
	// case, above all, which never reaches its own drain -- would otherwise
	// hand the next case an occupied slot, and the incumbent-wins rule would
	// DECLINE its arm. That turns an unrelated red into "no report delivered",
	// which is a red for the wrong reason.
	const { abortDeferredLspWork } =
		await import("../../clients/deferred-lsp-work.js");
	abortDeferredLspWork("test-teardown");
	env.cleanup();
	resetDegradationLedger();
});

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve to `"settled"` when `work` finishes first, `"pending"` when it is
 * still running after `ms`. Written as a race rather than an `await` so an
 * UNBOUNDED loop reports a failed assertion instead of hanging the suite until
 * vitest's own timeout — the pre-fix red has to be readable.
 */
async function settlesWithin(
	work: Promise<unknown>,
	ms: number,
): Promise<"settled" | "pending"> {
	return await Promise.race([
		work.then(() => "settled" as const),
		delay(ms).then(() => "pending" as const),
	]);
}

function makeSources(count: number): string[] {
	const dir = path.join(env.tmpDir, "src");
	fs.mkdirSync(dir, { recursive: true });
	const made: string[] = [];
	for (let i = 0; i < count; i++) {
		const p = path.join(dir, `f${i}.ts`);
		fs.writeFileSync(p, `export const v${i} = ${i};\n`);
		made.push(p);
	}
	return made;
}

async function loadWarnings() {
	return await import("../../clients/actionable-warnings.js");
}

describe("#2504 r2 F3 — per-round-trip bound on the deferred loop", () => {
	it("does not let a wedged getDiagnostics hold the deferred loop open", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(3);
		wedgedFiles.add("f0.ts");

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 150,
			onDeferredReport: () => {},
		});

		// Pre-fix the ONLY bound is a 60 s deadline checked BETWEEN files, so a
		// pull that never answers pins the loop forever.
		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 2_500)).toBe(
			"settled",
		);
		// And it moved PAST the wedged file rather than abandoning the batch.
		expect(getDiagnostics.mock.calls.length).toBe(3);
	});

	// #2523 slice 2. `boundedLspCall` used to be `withDeadline` (deadline
	// only) raced against an OPTIONAL `abortRace` leg carried on the deps —
	// so a deps object built without that leg silently degraded to the
	// deadline-only shape #2523 exists to remove, and the abandonment was
	// recorded nowhere. It is `bounded()` now. Revert the fold and this reds
	// on a missing `hook-await-exceeded` while the case above stays green,
	// which is the whole point: an elapsed-time assertion cannot tell a
	// hand-rolled both-bounds race from the shared one.
	it("records the abandoned round trip under hook-await-exceeded", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(3);
		wedgedFiles.add("f0.ts");

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 150,
			onDeferredReport: () => {},
		});
		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 2_500)).toBe(
			"settled",
		);

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "hook-await-exceeded",
		);
		// #2557 review F3: OFF the hook. This loop is the ANSWER to turn_end's
		// budget, not a spender of it — it runs a macrotask later on its own
		// ACTIONABLE_WARNINGS_DEFERRED_BUDGET_MS. Before, it recorded
		// `turn_end:lspEnrichmentRoundTrip`, which charged deliberately deferred
		// work to the hook that correctly deferred it.
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"off_hook:deferredLspEnrichmentRoundTrip",
		);
		// Rising edge, not one row per wedged file: three files share one row.
		expect(group?.count).toBe(1);
	});

	// #2557 review F3. `boundedLspCall` hard-coded `hook: "turn_end"` /
	// `label: "lspEnrichmentRoundTrip"` while being reached from BOTH loops, so
	// the two shared ONE ledger subject. `recordDegradationOnce` is rising-edge
	// per subject, which made that a mutual silencer: whichever loop blew its
	// budget first took the row, and the other's exceedance never surfaced for
	// the rest of the session. Revert the `site` field to a literal and this
	// case reds with only one subject present.
	it("keys the in-band and the deferred loop separately, so neither silences the other", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(2);
		wedgedFiles.add("f0.ts");

		// Turn 1 — nothing primed, so the cold set goes OFF the hook and its
		// wedged pull blows the per-trip bound there.
		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files: [files[0] as string],
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 120,
			onDeferredReport: () => {},
		});
		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 2_500)).toBe(
			"settled",
		);

		// Turn 2 — f1 is primed, which is exactly the condition that keeps the
		// whole enrichment IN BAND (`primed.length === 0` is what defers). The
		// same wedged f0 is now pulled on the AWAITED turn_end hook.
		primedByFile.set("f1.ts", []);
		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 2,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 120,
			onDeferredReport: () => {},
		});

		const subjects = (
			getDegradationSummary().find(
				(entry) => entry.kind === "hook-await-exceeded",
			)?.latestReasons ?? []
		).map((reason) => reason.subject);
		expect(subjects).toContain("off_hook:deferredLspEnrichmentRoundTrip");
		expect(subjects).toContain("turn_end:lspEnrichmentRoundTrip");
	});

	// #2557 review F-A. `boundedLspCall` passed `ms: Math.min(pullTimeoutMs,
	// remainingMs)` into `bounded()`, so whenever the LOOP's own residual wall
	// budget was smaller than the configured per-pull timeout, `bounded()`
	// armed its timer at the SHRUNKEN value and — on firing — recorded
	// `hook-await-exceeded` naming that shrunken value as the budget. A
	// perfectly healthy pull that simply started late in the batch (the loop's
	// OWN accounting running low, not the server being slow) was reported as
	// an exceedance of a budget "65ms" that exists in no configuration.
	// Reproduced here with three healthy 200 ms pulls against a 460 ms loop
	// budget: the third pull starts with ~60 ms of loop budget left but a
	// 10 s configured `lspPullTimeoutMs` — nowhere near exceeded.
	it("does not record hook-await-exceeded for a healthy pull the loop's own shrinking residual cut short", async () => {
		const { buildActionableWarningsReport } = await loadWarnings();
		const files = makeSources(4);
		// One cached file keeps the batch IN BAND (primed.length > 0), so the
		// cold files below run through `inBandDeps` — the awaited `turn_end`
		// loop, not the deferred one.
		primedByFile.set("f0.ts", []);
		pullDelayMs = 200;

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			// Far larger than any single healthy pull -- a call is a genuine
			// exceedance only if IT outlives this, never the loop's residual.
			lspPullTimeoutMs: 10_000,
			// f1 + f2 healthy pulls cost ~400ms; f3 starts with ~60ms of loop
			// budget left, well under its own 200ms pull time but nowhere near
			// its 10s per-call timeout.
			lspBudgetMs: 460,
			onDeferredReport: () => {},
		});

		expect(getDegradationSummary()).toEqual([]);
	});

	// The companion half of the F-A fix: not recording on a residual clamp
	// must not regress into not ENFORCING one either. `bounded()`'s own timer
	// is armed at the full `pullTimeoutMs` (10 s below); only the outer
	// `withDeadline` keyed to the loop's own `deadlineAt` can cut a wedged
	// pull off after ~60 ms instead of the full per-call timeout. Raced with
	// a generous ceiling (not an elapsed-time delta) so the assertion is the
	// settle/pending outcome, not a wall-clock number.
	it("still cuts a wedged pull off at the loop's own shrinking residual, not the full per-call timeout", async () => {
		const { buildActionableWarningsReport } = await loadWarnings();
		const files = makeSources(2);
		primedByFile.set("f0.ts", []);
		wedgedFiles.add("f1.ts");

		const settled = await settlesWithin(
			buildActionableWarningsReport({
				cwd: env.tmpDir,
				sessionId: "lens-test",
				turnIndex: 1,
				files,
				modifiedRangesByFile: new Map(),
				dispatchWarnings: [],
				includeLspCodeActions: true,
				lspPullTimeoutMs: 10_000,
				lspBudgetMs: 60,
				onDeferredReport: () => {},
			}),
			2_500,
		);
		expect(settled).toBe("settled");
	});
});

describe("#2504 r2 F3 — session_shutdown aborts the deferred loop", () => {
	it("stops within the per-pull bound and opens no further file", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		// The REAL teardown entry point — every lifecycle path (session_shutdown,
		// session_start, the idle reset) retires the service through it.
		const { resetLSPService } = await import("../../clients/lsp/index.js");
		const files = makeSources(6);
		for (const f of files) wedgedFiles.add(path.basename(f));

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: () => {},
		});

		// Let the loop get into its first (wedged) pull.
		await delay(50);
		const openedBeforeShutdown = openFile.mock.calls.length;
		expect(openedBeforeShutdown).toBeGreaterThan(0);

		resetLSPService({
			fast: true,
			processExiting: true,
			reason: "session_shutdown",
		});

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 2_500)).toBe(
			"settled",
		);
		// No further document was handed to a service being torn down.
		expect(openFile.mock.calls.length).toBe(openedBeforeShutdown);
	});

	it("delivers no report from an aborted loop", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const { resetLSPService } = await import("../../clients/lsp/index.js");
		const files = makeSources(4);
		for (const f of files) wedgedFiles.add(path.basename(f));
		const delivered: unknown[] = [];

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: (r: unknown) => delivered.push(r),
		});

		await delay(50);
		resetLSPService({ fast: true, reason: "session_start" });

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 2_500)).toBe(
			"settled",
		);
		expect(delivered).toEqual([]);
	});
});

describe("#2504 r3 F-A(d) — a second cold-cache turn lets the first finish", () => {
	it("declines the second arm instead of cancelling the in-flight loop", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(2);
		// Keeps loop 1 in flight while turn 2 arrives; it clears on the
		// per-round-trip bound, so the loop still finishes and publishes.
		wedgedFiles.add(path.basename(files[0]));
		const delivered: ActionableWarningsReport[] = [];

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 400,
			onDeferredReport: (r: ActionableWarningsReport) => delivered.push(r),
		});
		// The handle for the FIRST loop, captured before anything else arms.
		const first = _awaitDeferredLspPullForTest();
		await delay(50);

		// Turn 2 is ALSO cold-cache — in a real editing session every turn is,
		// which is why round 2's abort-on-arm meant back-to-back editing turns
		// delivered NOTHING: each arm cancelled its predecessor, and an aborted
		// loop publishes nothing by design. One slot, but the incumbent keeps
		// it; the newcomer is declined and says so.
		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 2,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: (r: ActionableWarningsReport) => delivered.push(r),
		});

		expect(await settlesWithin(first, 6_000)).toBe("settled");
		expect(delivered.map((r) => r.turnIndex)).toEqual([1]);
	});

	it("arms again once the previous deferral has finished", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(1);
		const delivered: ActionableWarningsReport[] = [];

		for (const turnIndex of [1, 2]) {
			await buildActionableWarningsReport({
				cwd: env.tmpDir,
				sessionId: "lens-test",
				turnIndex,
				files,
				modifiedRangesByFile: new Map(),
				dispatchWarnings: [],
				includeLspCodeActions: true,
				lspPullTimeoutMs: 400,
				onDeferredReport: (r: ActionableWarningsReport) => delivered.push(r),
			});
			expect(await settlesWithin(_awaitDeferredLspPullForTest(), 4_000)).toBe(
				"settled",
			);
		}

		// Declining is not a latch: the slot is released the moment the work
		// settles, so the very next cold-cache turn defers normally.
		expect(delivered.map((r) => r.turnIndex)).toEqual([1, 2]);
	});

	it("still lets resetLSPService retire the incumbent", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const { resetLSPService } = await import("../../clients/lsp/index.js");
		const files = makeSources(5);
		for (const f of files) wedgedFiles.add(path.basename(f));

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: () => {},
		});
		const first = _awaitDeferredLspPullForTest();
		await delay(50);

		// Holding the slot against a NEWER TURN must not also hold it against
		// TEARDOWN: the service lifecycle seam still wins, unconditionally.
		resetLSPService({ fast: true, reason: "session_start" });
		expect(await settlesWithin(first, 2_500)).toBe("settled");
	});
});

describe("#2504 r2 F2 — a deferred report never clobbers a newer one", () => {
	it("keeps turn N+1's report when turn N's deferred loop lands after it", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		const source = makeSources(1)[0];
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		// One wedged file is enough to keep the deferred loop running while
		// "turn N+1" writes underneath it.
		wedgedFiles.add(path.basename(source));

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: (name: string) =>
				name === "lens-actionable-warnings" ||
				name === "lens-actionable-warning-actions",
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
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		const turnNReport = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(turnNReport).toBeDefined();

		// Turn N+1 completes and writes its own, NEWER report while turn N's
		// deferred loop is still pulling.
		const newer: ActionableWarningsReport = {
			...(turnNReport as ActionableWarningsReport),
			generatedAt: new Date().toISOString(),
			turnIndex: (turnNReport as ActionableWarningsReport).turnIndex + 1,
			projectSeqStart: 40,
			projectSeqEnd: 41,
			files: [],
		};
		cacheManager.writeCache("actionable-warnings", newer, env.tmpDir);

		// Unwedge, so the deferred loop finishes and tries to publish.
		wedgedFiles.clear();
		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.turnIndex).toBe(newer.turnIndex);
		expect(persisted?.projectSeqEnd).toBe(41);
	});
});

/**
 * #2504 review round 3 — the deferral's DELIVERY half.
 *
 * Round 2 bounded the loop and guarded its write. Neither half had a positive
 * test: neutering `writeDeferredActionableWarningsReport` to never write left
 * all eight suites green (98/98), because every deferral assertion was about a
 * loop STOPPING. AC3 is not "the sweep stops holding the terminal", it is "the
 * findings still reach the agent, by the cached channel, one turn later at
 * worst". These tests pin that second clause.
 */

/** One unused-variable warning on the modified line, plus its quickfix. */
function armOneActionableWarning(basename: string): void {
	diagnosticsByFile.set(basename, [
		{
			severity: 2,
			message: "v0 is declared but its value is never read.",
			range: {
				start: { line: 0, character: 13 },
				end: { line: 0, character: 15 },
			},
			source: "ts",
			code: 6133,
		},
	]);
	codeActions = [
		{
			title: "Remove unused declaration for v0",
			kind: "quickfix",
			edit: { changes: {} },
		},
	];
}

/** The minimal `turn_end` deps the actionable-warnings path needs. */
function turnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
): unknown {
	return {
		ctxCwd: env.tmpDir,
		getFlag: (name: string) =>
			name === "lens-actionable-warnings" ||
			name === "lens-actionable-warning-actions",
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
	};
}

describe("#2504 r3 F-A — the deferred report is actually DELIVERED", () => {
	it("lands the off-hook findings in the cache when nothing newer is persisted", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		const source = makeSources(1)[0];
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		armOneActionableWarning(path.basename(source));

		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		// The AWAITED report carries nothing: the turn primed no LSP cache, so
		// every pull was deferred. That is the whole point of #2504 — turn_end
		// returns without the 187 s sweep.
		const inBand = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(inBand?.summary.files).toBe(0);

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);
		// The pull genuinely happened, off the hook, exactly once.
		expect(getDiagnostics.mock.calls.length).toBe(1);

		// …and the finding it produced REPLACED the empty in-band report, which
		// is the only way the agent ever sees it.
		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.summary.files).toBe(1);
		expect(persisted?.files[0]?.warnings[0]?.actions.length).toBeGreaterThan(0);
	});

	it("publishes even though the NEXT turn edited a DIFFERENT file", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		const [source, other] = makeSources(2);
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		armOneActionableWarning(path.basename(source));

		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		// The next turn edits a file before the deferral finishes. That is the
		// ordinary case, not an edge: the deferral exists precisely because the
		// session is editing. The file under the deferred pull has NOT moved, so
		// its entry still describes current content and must be published.
		runtime.recordProjectMutation({ filePath: other, source: "agent-edit" });
		expect(runtime.projectSeq).toBeGreaterThan(0);

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.summary.files).toBe(1);
	});

	it("drops the entry for the file the NEXT turn edited, and says so", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		const source = makeSources(1)[0];
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		armOneActionableWarning(path.basename(source));

		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		// THIS file moves while the deferred pull is reading it. Its findings
		// cite lines in content that no longer exists, and publishing them would
		// also poison checkActionableWarningsReportFresh for the whole report.
		runtime.recordProjectMutation({ filePath: source, source: "agent-edit" });

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.summary.files).toBe(0);
		const superseded = getDegradationSummary().filter(
			(group) => group.kind === "actionable-warnings-deferred-superseded",
		);
		expect(superseded.length).toBe(1);
		expect(superseded[0].latestReasons[0].reason).toContain("LOST");
	});
});

/**
 * #2504 review round 4 (F1) — the deferred report MERGES, per file.
 *
 * Rounds 2 and 3 ordered whole reports: publish, or discard on a newer
 * persisted turnIndex/projectSeqEnd. Composed with incumbent-wins that could
 * only ever discard. Every turn_end with modified files persists an in-band
 * report whose turnIndex strictly increases, and the decline fires exactly
 * when such a turn runs while a loop is in flight — so a decline implied a
 * supersede, always, and the declining turn's EMPTY placeholder out-ranked the
 * incumbent's real findings on ordering alone.
 */
describe("#2504 r4 F1 — the deferred report merges into the persisted one", () => {
	function warning(
		filePath: string,
		id: string,
	): ActionableWarningsReport["files"][number]["warnings"][number] {
		return {
			id,
			filePath,
			displayPath: path.basename(filePath),
			line: 1,
			severity: "warning",
			tool: "typescript",
			message: `finding ${id}`,
			actions: [
				{
					title: "Fix it",
					kind: "quickfix",
					hasEdit: true,
					hasCommand: false,
					autoFixEligible: true,
				},
			],
			suppressed: false,
			origin: "lsp",
		};
	}

	function baseReport(
		over: Partial<ActionableWarningsReport>,
	): ActionableWarningsReport {
		return {
			generatedAt: new Date(2_000_000).toISOString(),
			scope: "turn_delta",
			sessionId: "lens-test",
			turnIndex: 7,
			projectSeqStart: 39,
			projectSeqEnd: 40,
			deltaOnly: true,
			includeLspCodeActions: true,
			files: [],
			summary: {
				warnings: 0,
				unsuppressed: 0,
				byTier: { warning: 0, info: 0, hint: 0 },
				suppressed: 0,
				files: 0,
				actions: 0,
				autoFixEligible: 0,
			},
			...over,
		} as ActionableWarningsReport;
	}

	function fileEntry(
		filePath: string,
		id: string,
		fileSeq: number,
		generatedAt: string,
	): ActionableWarningsReport["files"][number] {
		return {
			filePath,
			displayPath: path.basename(filePath),
			fileSeq,
			generatedAt,
			warnings: [warning(filePath, id)],
		};
	}

	it("upserts its entries into a NEWER persisted report instead of being discarded", async () => {
		const { writeDeferredActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [a, b] = makeSources(2);

		// The NEXT turn's in-band report: newer on BOTH whole-report orderings
		// that round 3 refused on.
		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				turnIndex: 8,
				projectSeqEnd: 41,
				generatedAt: new Date(3_000_000).toISOString(),
				files: [fileEntry(b, "b1", 2, new Date(3_000_000).toISOString())],
			}),
			env.tmpDir,
		);

		const result = writeDeferredActionableWarningsReport({
			cacheManager,
			cwd: env.tmpDir,
			report: baseReport({
				files: [fileEntry(a, "a1", 5, new Date(2_000_000).toISOString())],
			}),
			// Neither file has moved since its entry was built.
			getFileSeq: (filePath) => (filePath === a ? 5 : 2),
		});

		expect(result.mergedFiles).toBe(1);
		expect(result.droppedFiles).toBe(0);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		const ids = (persisted?.files ?? []).flatMap((f) =>
			f.warnings.map((w) => w.id),
		);
		expect(ids.sort()).toEqual(["a1", "b1"]);
		// The merged report never claims to be older than its newest part.
		expect(persisted?.turnIndex).toBe(8);
		expect(persisted?.projectSeqEnd).toBe(41);
	});

	it("drops only the file whose fileSeq advanced, and records that loss", async () => {
		const { writeDeferredActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [a, b] = makeSources(2);

		const result = writeDeferredActionableWarningsReport({
			cacheManager,
			cwd: env.tmpDir,
			report: baseReport({
				files: [
					fileEntry(a, "a1", 5, new Date(2_000_000).toISOString()),
					fileEntry(b, "b1", 2, new Date(2_000_000).toISOString()),
				],
			}),
			// `a` was edited while the deferred pull was reading it; `b` was not.
			getFileSeq: (filePath) => (filePath === a ? 6 : 2),
		});

		// Behaviour first, counters second: the red on pre-fix code has to be
		// "it published the stale entry", not "the result object grew a field".
		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(
			(persisted?.files ?? []).flatMap((f) => f.warnings.map((w) => w.id)),
		).toEqual(["b1"]);
		expect(result.mergedFiles).toBe(1);
		expect(result.droppedFiles).toBe(1);

		// Never silent: the per-file loss is on the ledger, bounded and named.
		const superseded = getDegradationSummary().filter(
			(group) => group.kind === "actionable-warnings-deferred-superseded",
		);
		expect(superseded.length).toBe(1);
		expect(superseded[0].latestReasons[0].reason).toContain(path.basename(a));
	});

	it("unions the warnings when both halves hold the same file", async () => {
		const { writeDeferredActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [a] = makeSources(1);

		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				turnIndex: 8,
				files: [fileEntry(a, "fresh", 5, new Date(3_000_000).toISOString())],
			}),
			env.tmpDir,
		);
		writeDeferredActionableWarningsReport({
			cacheManager,
			cwd: env.tmpDir,
			report: baseReport({
				files: [fileEntry(a, "deferred", 5, new Date(2_000_000).toISOString())],
			}),
			getFileSeq: () => 5,
		});

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.files.length).toBe(1);
		expect(persisted?.files[0].warnings.map((w) => w.id).sort()).toEqual([
			"deferred",
			"fresh",
		]);
		// The entry now carries both observations, so it must be aged by the
		// EARLIER of them — an out-of-band edit after that moment makes every
		// line in it suspect, not only the older half's.
		expect(persisted?.files[0].generatedAt).toBe(
			new Date(2_000_000).toISOString(),
		);
		expect(persisted?.summary.warnings).toBe(2);
	});
});
describe("#2504 r3 F-B — an unacknowledged open is never read as clean", () => {
	it("skips the file rather than pulling for a document the server never received", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(1);
		wedgedOpens.add(path.basename(files[0]));

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 200,
			onDeferredReport: () => {},
		});

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 4_000)).toBe(
			"settled",
		);
		// #240. The bounded `openFile` lost to its timeout, so the server never
		// received the document. Pulling anyway asks it about a file it has
		// never seen; the empty answer means UNKNOWN, and the pre-fix code
		// logged the file `lsp_file_checked lspSource:"fresh"` — a failed pull
		// read as clean, which is exactly what the comment beside the pull
		// promises never happens.
		expect(getDiagnostics.mock.calls.length).toBe(0);
	});

	it("still pulls when the open was acknowledged", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(1);

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 200,
			onDeferredReport: () => {},
		});

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 4_000)).toBe(
			"settled",
		);
		expect(getDiagnostics.mock.calls.length).toBe(1);
	});
});

/**
 * #2504 review round 4 (F1) — the reviewer's P1 choreography, end to end.
 *
 * Two back-to-back cold turns through the REAL handleTurnEnd. Turn 0 arms a
 * deferral; turn 1 runs while that loop is still in flight, so its own cold
 * files are declined, and it persists its in-band report with a strictly
 * higher turnIndex. Then turn 0's loop lands.
 *
 * Pre-fix that composition published NOTHING: the incumbent's real findings
 * lost to the declining turn's report on whole-report ordering alone, and the
 * declining turn had nothing of its own to contribute for the files it
 * skipped. Both turns' warnings were gone.
 */
describe("#2504 r4 F1 — two back-to-back cold turns both deliver", () => {
	it("keeps turn 1's in-band entries AND turn 0's deferred finding", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const [deferredFile, dispatchFile] = makeSources(2);

		// ── turn 0: one modified file, nothing primed, so the loop defers.
		runtime.beginTurn();
		cacheManager.addModifiedRange(
			deferredFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		armOneActionableWarning(path.basename(deferredFile));
		// Wedged, so turn 0's loop is still in flight when turn 1 runs.
		wedgedFiles.add(path.basename(deferredFile));
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);
		const turnZeroIndex = runtime.turnIndex;

		// ── turn 1: a dispatch warning of its own, plus a cold file whose
		// deferral is DECLINED because turn 0 still holds the slot.
		runtime.beginTurn();
		expect(runtime.turnIndex).toBeGreaterThan(turnZeroIndex);
		cacheManager.addModifiedRange(
			dispatchFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		runtime.recordActionableWarnings([
			{
				id: "turn1-dispatch",
				filePath: dispatchFile,
				displayPath: path.basename(dispatchFile),
				line: 1,
				severity: "warning",
				tool: "ast-grep",
				message: "turn 1 found this itself",
				actions: [],
				suppressed: false,
				origin: "dispatch",
			},
		]);
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		const afterTurnOne = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(
			(afterTurnOne?.files ?? []).flatMap((f) => f.warnings.map((w) => w.id)),
		).toEqual(["turn1-dispatch"]);

		// ── turn 0's incumbent loop finally lands.
		wedgedFiles.clear();
		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);

		const finalReport = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		const paths = (finalReport?.files ?? []).map((f) => f.filePath).sort();
		expect(paths).toEqual([deferredFile, dispatchFile].sort());
		// Turn 1 kept what it found in band...
		expect(
			(finalReport?.files ?? []).flatMap((f) => f.warnings.map((w) => w.id)),
		).toContain("turn1-dispatch");
		// ...and turn 0's deferred LSP finding arrived beside it, with its fix
		// action, which is the only way the agent ever sees it.
		const deferredEntry = (finalReport?.files ?? []).find(
			(f) => f.filePath === deferredFile,
		);
		expect(deferredEntry?.warnings.length).toBe(1);
		expect(deferredEntry?.warnings[0].actions.length).toBeGreaterThan(0);
		expect(finalReport?.summary.files).toBe(2);
	});
});

/**
 * #2504 review round 4 (F1), the consumer half. A merged report is a NEW
 * shape for everything that reads the actionable-warnings cache, so the
 * freshness contract has to be pinned on the merged object, not only on the
 * merge.
 */
describe("#2504 r4 F1 — consumers accept a merged report", () => {
	it("passes checkActionableWarningsReportFresh with the deferred half included", async () => {
		const {
			writeDeferredActionableWarningsReport,
			checkActionableWarningsReportFresh,
		} = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [a, b] = makeSources(2);
		const seqByPath = new Map([
			[a, 5],
			[b, 2],
		]);

		const entry = (filePath: string, id: string, generatedAt: string) => ({
			filePath,
			displayPath: path.basename(filePath),
			fileSeq: seqByPath.get(filePath),
			generatedAt,
			warnings: [
				{
					id,
					filePath,
					displayPath: path.basename(filePath),
					line: 1,
					severity: "warning" as const,
					tool: "typescript",
					message: `finding ${id}`,
					actions: [],
					suppressed: false,
					origin: "lsp" as const,
				},
			],
		});
		const report = (
			over: Partial<ActionableWarningsReport>,
		): ActionableWarningsReport =>
			({
				generatedAt: new Date(2_000_000).toISOString(),
				scope: "turn_delta",
				sessionId: "lens-test",
				turnIndex: 7,
				projectSeqStart: 39,
				projectSeqEnd: 40,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [],
				summary: {
					warnings: 0,
					unsuppressed: 0,
					byTier: { warning: 0, info: 0, hint: 0 },
					suppressed: 0,
					files: 0,
					actions: 0,
					autoFixEligible: 0,
				},
				...over,
			}) as ActionableWarningsReport;

		cacheManager.writeCache(
			"actionable-warnings",
			report({
				turnIndex: 8,
				projectSeqEnd: 41,
				generatedAt: new Date(3_000_000).toISOString(),
				files: [entry(b, "b1", new Date(3_000_000).toISOString())],
			}),
			env.tmpDir,
		);
		writeDeferredActionableWarningsReport({
			cacheManager,
			cwd: env.tmpDir,
			report: report({
				files: [entry(a, "a1", new Date(2_000_000).toISOString())],
			}),
			getFileSeq: (filePath) => seqByPath.get(filePath) ?? 0,
		});

		const merged = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data as ActionableWarningsReport;
		expect(merged.files.map((f) => f.filePath).sort()).toEqual([a, b].sort());

		// projectSeqEnd is the MAX of the parts, so exact equality with the live
		// projectSeq still holds, and every entry's own fileSeq re-checks clean.
		const freshness = checkActionableWarningsReportFresh({
			report: merged,
			currentProjectSeq: 41,
			getFileSeq: (filePath) => seqByPath.get(filePath) ?? 0,
		});
		expect(freshness.reason).toBeUndefined();
		expect(freshness.fresh).toBe(true);

		// ...and one entry going stale still rejects the report, per file.
		const stale = checkActionableWarningsReportFresh({
			report: merged,
			currentProjectSeq: 41,
			getFileSeq: (filePath) => (filePath === a ? 6 : 2),
		});
		expect(stale.fresh).toBe(false);
		expect(stale.reason).toBe("file_seq_mismatch");
		expect(stale.filePath).toBe(a);
	});
});

/**
 * #2504 review round 5 (F1) — the in-band write was a BLIND OVERWRITE.
 *
 * `runtime-turn.ts` wrote the turn's own report with a bare
 * `writeActionableWarningsReport` while the deferred callback beside it
 * read-modify-wrote the SAME cache key. Everything between arming the
 * deferral and that write is awaited — the cascade settle, knip, madge, the
 * test batch, the in-band LSP enrichment — so a deferred merge that lands
 * inside turn N+1's handleTurnEnd is erased by it. The reviewer measured the
 * gap at 607 ms: "merged 1 entry -> writeCache files=[f1.ts] -> final
 * [f1.ts]", with f0 gone.
 *
 * The window is forced open deterministically here rather than raced: turn 1's
 * `depChecker.ensureAvailable` — a dep the REAL handleTurnEnd awaits well
 * before it publishes — waits for turn 0's deferred loop to land. Production
 * code from `handleTurnEnd` down is untouched; only the moment the deferral
 * settles is pinned, which is exactly the variable a race test must control.
 */
describe("#2504 r5 F1 — a deferred merge that lands mid-turn survives", () => {
	/** turn_end deps whose madge step blocks until `gate` resolves. */
	function gatedTurnEndDeps(
		runtime: RuntimeCoordinator,
		cacheManager: CacheManager,
		gate: () => Promise<unknown>,
	): unknown {
		return {
			...(turnEndDeps(runtime, cacheManager) as Record<string, unknown>),
			getFlag: (name: string) =>
				name === "lens-actionable-warnings" ||
				name === "lens-actionable-warning-actions" ||
				name === "lens-turn-end-madge",
			depChecker: {
				ensureAvailable: async () => {
					await gate();
					// False, so nothing else in the madge branch runs.
					return false;
				},
			},
		};
	}

	it("keeps the deferred entry AND turn N+1's own, instead of clobbering it", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const [deferredFile, dispatchFile] = makeSources(2);

		// ── turn 0: one modified file, nothing primed, so its pull is deferred.
		runtime.beginTurn();
		cacheManager.addModifiedRange(
			deferredFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		armOneActionableWarning(path.basename(deferredFile));
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);
		// The awaited report carries nothing — that is #2504's whole point.
		expect(
			cacheManager.readCache<ActionableWarningsReport>(
				"actionable-warnings",
				env.tmpDir,
			)?.data?.summary.files,
		).toBe(0);

		// ── turn 1: its own dispatch finding, and turn 0's deferral lands
		// while this handleTurnEnd is still running.
		runtime.beginTurn();
		cacheManager.addModifiedRange(
			dispatchFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		runtime.recordActionableWarnings([
			{
				id: "turn1-dispatch",
				filePath: dispatchFile,
				displayPath: path.basename(dispatchFile),
				line: 1,
				severity: "warning",
				tool: "ast-grep",
				message: "turn 1 found this itself",
				actions: [],
				suppressed: false,
				origin: "dispatch",
			},
		]);

		let landedMidTurn = false;
		const gatedDeps = gatedTurnEndDeps(runtime, cacheManager, async () => {
			// Turn 0's loop has not started yet: it yields a macrotask before
			// its first pull, and everything since has been microtasks.
			await _awaitDeferredLspPullForTest();
			const midTurn = cacheManager.readCache<ActionableWarningsReport>(
				"actionable-warnings",
				env.tmpDir,
			)?.data;
			landedMidTurn = (midTurn?.summary.files ?? 0) === 1;
		});
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(gatedDeps as any);

		// Premise check: the deferred merge really did land INSIDE turn 1's
		// handleTurnEnd, before its own publish. Without this the case could go
		// green for the wrong reason.
		expect(landedMidTurn).toBe(true);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		const paths = (persisted?.files ?? []).map((f) => f.filePath).sort();
		// Pre-fix: [dispatchFile] only — the blind write erased the merge.
		expect(paths).toEqual([deferredFile, dispatchFile].sort());
		expect(
			(persisted?.files ?? []).flatMap((f) => f.warnings.map((w) => w.id)),
		).toContain("turn1-dispatch");
		const rescued = (persisted?.files ?? []).find(
			(f) => f.filePath === deferredFile,
		);
		expect(rescued?.warnings.length).toBe(1);
		// Its fix action is the only reason the deferral is worth delivering.
		expect(rescued?.warnings[0].actions.length).toBeGreaterThan(0);
		expect(persisted?.summary.files).toBe(2);

		// Drain turn 1's own deferral so nothing outlives the test.
		await settlesWithin(_awaitDeferredLspPullForTest(), 8_000);
	});

	it("does NOT accumulate entries across turns when nothing was deferred", async () => {
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const [first, second] = makeSources(2);

		// The scope guard on the F1 fix. `publishActionableWarningsReport` reads
		// the persisted report on EVERY publish; if it carried every entry
		// forward, a report whose own `scope` says "turn_delta" would grow
		// without bound and re-serve findings the agent already acted on. Only
		// an entry a DEFERRAL produced is carried, and only once.
		//
		// No LSP enrichment here (the actions flag is off), so no deferral is
		// ever armed and nothing is eligible to carry.
		const deps = (r: RuntimeCoordinator) => ({
			...(turnEndDeps(r, cacheManager) as Record<string, unknown>),
			getFlag: (name: string) => name === "lens-actionable-warnings",
		});

		for (const [file, id] of [
			[first, "turn1-only"],
			[second, "turn2-only"],
		] as const) {
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				file,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				runtime.telemetrySessionId,
			);
			runtime.recordActionableWarnings([
				{
					id,
					filePath: file,
					displayPath: path.basename(file),
					line: 1,
					severity: "warning",
					tool: "ast-grep",
					message: `finding ${id}`,
					actions: [],
					suppressed: false,
					origin: "dispatch",
				},
			]);
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
			await handleTurnEnd(deps(runtime) as any);
		}

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(
			(persisted?.files ?? []).flatMap((f) => f.warnings.map((w) => w.id)),
		).toEqual(["turn2-only"]);
		expect(persisted?.files.map((f) => f.filePath)).toEqual([second]);
	});
});

/**
 * #2504 review round 5 (F2) — one assembly stamp for a loop that runs minutes.
 *
 * `assembleReport` took a single `new Date()` and put it on every entry. For
 * the deferred loop that moment is the loop's END: with the shipped bounds
 * that is up to 25 files x ~880 ms, so the FIRST file's entry claimed to have
 * been observed ~21 s after it actually was. `applyDeltaFreshnessGate`
 * compares that stamp against the file's mtime precisely to catch an edit made
 * after the observation — handed a stamp that late, the window it checks has
 * already closed and an out-of-band edit is served as live.
 */
describe("#2504 r5 F2 — each entry is stamped when its own pull returned", () => {
	it("gives five files five stamps, none later than its own observation", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(5);
		for (const file of files) armOneActionableWarning(path.basename(file));
		pullDelayMs = 400;
		let delivered: ActionableWarningsReport | undefined;

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			deltaOnly: false,
			lspPullTimeoutMs: 5_000,
			onDeferredReport: (r: ActionableWarningsReport) => {
				delivered = r;
			},
		});

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 20_000)).toBe(
			"settled",
		);
		expect(delivered?.files.length).toBe(5);

		const entries = delivered?.files ?? [];
		// Pre-fix every entry carried the SAME stamp, taken at assembly.
		expect(new Set(entries.map((f) => f.generatedAt)).size).toBe(5);

		for (const entry of entries) {
			const base = path.basename(entry.filePath);
			const startedAt = pullStartedAt.get(base);
			const returnedAt = pullReturnedAt.get(base);
			expect(startedAt).toBeDefined();
			expect(returnedAt).toBeDefined();
			const stamp = Date.parse(entry.generatedAt as string);
			expect(Number.isFinite(stamp)).toBe(true);
			// The clause the gate depends on: an entry never claims to be
			// FRESHER than the observation behind it. Pre-fix the first file
			// overshot by the whole remaining loop (~1.6 s here, ~21 s in
			// production at the shipped 25-file cap).
			expect(stamp).toBeLessThanOrEqual((returnedAt as number) + 250);
			expect(stamp).toBeGreaterThanOrEqual(startedAt as number);
		}

		// And the spread is real, not two stamps a millisecond apart: the first
		// file's entry is at least three pull-lengths older than the last.
		const stamps = entries
			.map((f) => Date.parse(f.generatedAt as string))
			.sort((a, b) => a - b);
		expect(stamps[stamps.length - 1] - stamps[0]).toBeGreaterThanOrEqual(
			3 * 400,
		);
	});
});

/**
 * #2504 review round 6 (F1) — a quit-\>resume kept pi's telemetry sessionId
 * STABLE (`setSessionLifecycle`, `runtime-coordinator.ts:677-682`), which
 * used to be enough to pass the merge's same-sessionId carry-forward gate.
 * But `resetForSession` clears the live `_fileSeq` map for the new process
 * (`runtime-coordinator.ts:397`), so a file the resumed process has not
 * touched answers `getFileSeq` 0 -- and the gate's `baselineSeq >
 * entry.fileSeq` comparison read `0 > 7` as false, carrying a pre-restart
 * deferred entry into the resumed process's very first in-band publish. That
 * stale entry then poisoned `checkActionableWarningsReportFresh`
 * (`file_seq_mismatch`, first mismatch wins), so `agent_end` silently skipped
 * the whole autofix pass over a report that otherwise had nothing wrong with
 * it.
 *
 * Fixed by requiring EXACT equality against a live baseline on the in-band
 * carry-forward path (rather than "baseline advanced past it"), which makes
 * the sessionId gate redundant: an unmoved file's live seq matches its
 * recorded entry seq exactly, in-session or across a resume; any mismatch
 * (including the reset-to-0 case) drops it.
 */
describe("#2504 r6 F1 — a resumed process's reset fileSeq no longer resurrects a stale deferred entry", () => {
	function warning(
		filePath: string,
		id: string,
	): ActionableWarningsReport["files"][number]["warnings"][number] {
		return {
			id,
			filePath,
			displayPath: path.basename(filePath),
			line: 1,
			severity: "warning",
			tool: "typescript",
			message: `finding ${id}`,
			actions: [
				{
					title: "Fix it",
					kind: "quickfix",
					hasEdit: true,
					hasCommand: false,
					autoFixEligible: true,
				},
			],
			suppressed: false,
			origin: "lsp",
		};
	}

	function baseReport(
		over: Partial<ActionableWarningsReport>,
	): ActionableWarningsReport {
		return {
			generatedAt: new Date(2_000_000).toISOString(),
			scope: "turn_delta",
			sessionId: "lens-test",
			turnIndex: 7,
			projectSeqStart: 0,
			projectSeqEnd: 1,
			deltaOnly: true,
			includeLspCodeActions: true,
			files: [],
			summary: {
				warnings: 0,
				unsuppressed: 0,
				byTier: { warning: 0, info: 0, hint: 0 },
				suppressed: 0,
				files: 0,
				actions: 0,
				autoFixEligible: 0,
			},
			...over,
		} as ActionableWarningsReport;
	}

	it("drops STALE-A instead of carrying it into process B's turn-1 report", async () => {
		const {
			publishActionableWarningsReport,
			checkActionableWarningsReportFresh,
		} = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [stale] = makeSources(1);
		const sharedSessionId = "lens-stable-resume-id";

		// Process A, pre-restart: a deferred publish left an UNSPENT entry
		// (origin: "deferred") recorded at fileSeq 7.
		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				sessionId: sharedSessionId,
				turnIndex: 3,
				projectSeqEnd: 10,
				files: [
					{
						...{
							filePath: stale,
							displayPath: path.basename(stale),
							fileSeq: 7,
							generatedAt: new Date(2_000_000).toISOString(),
							warnings: [warning(stale, "STALE-A")],
						},
						origin: "deferred" as const,
					},
				],
			}),
			env.tmpDir,
		);

		// Process B: a genuinely fresh RuntimeCoordinator, the shape a resumed
		// process actually gets (resetForSession already ran, then
		// setSessionLifecycle pinned pi's stable id) -- its `_fileSeq` map is
		// empty, so `getFileSeq` for the untouched `stale` file answers 0.
		const runtimeB = new RuntimeCoordinator();
		runtimeB.setSessionLifecycle({ sessionId: sharedSessionId });
		expect(runtimeB.telemetrySessionId).toBe(sharedSessionId);
		expect(runtimeB.getFileSeq(stale)).toBe(0);

		const result = publishActionableWarningsReport(
			cacheManager,
			env.tmpDir,
			baseReport({
				sessionId: sharedSessionId,
				turnIndex: 1,
				projectSeqEnd: 1,
				files: [],
			}),
			{
				origin: "in-band",
				getFileSeq: (filePath: string) => runtimeB.getFileSeq(filePath),
			},
		);

		expect(result.droppedFiles).toContain(path.basename(stale));
		expect((result.report.files ?? []).some((f) => f.filePath === stale)).toBe(
			false,
		);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect((persisted?.files ?? []).some((f) => f.filePath === stale)).toBe(
			false,
		);

		// And with the entry gone at merge time, the freshness gate never trips
		// on it -- `agent_end`'s autofix pass is not skipped over a report that
		// otherwise has nothing stale in it.
		const freshness = checkActionableWarningsReportFresh({
			report: persisted as ActionableWarningsReport,
			currentProjectSeq: 1,
			getFileSeq: (filePath: string) => runtimeB.getFileSeq(filePath),
		});
		expect(freshness.fresh).toBe(true);
	});
});

/**
 * #2504 review round 6 (F2) — the marker spend (`merged.origin = undefined`)
 * is what stops a carried entry from accumulating forever. A mutation that
 * deletes that line left 277/279 of the existing suite green, because no
 * existing case carries the SAME entry across three publishes: round 5's
 * "does NOT accumulate" case never defers anything, so nothing is ever
 * eligible to carry in the first place.
 */
describe("#2504 r6 F2 — the marker spend actually stops accumulation on the third turn", () => {
	function warning(
		filePath: string,
		id: string,
	): ActionableWarningsReport["files"][number]["warnings"][number] {
		return {
			id,
			filePath,
			displayPath: path.basename(filePath),
			line: 1,
			severity: "warning",
			tool: "typescript",
			message: `finding ${id}`,
			actions: [],
			suppressed: false,
			origin: "lsp",
		};
	}

	function baseReport(
		over: Partial<ActionableWarningsReport>,
	): ActionableWarningsReport {
		return {
			generatedAt: new Date(2_000_000).toISOString(),
			scope: "turn_delta",
			sessionId: "lens-test",
			turnIndex: 0,
			projectSeqStart: 0,
			projectSeqEnd: 1,
			deltaOnly: true,
			includeLspCodeActions: true,
			files: [],
			summary: {
				warnings: 0,
				unsuppressed: 0,
				byTier: { warning: 0, info: 0, hint: 0 },
				suppressed: 0,
				files: 0,
				actions: 0,
				autoFixEligible: 0,
			},
			...over,
		} as ActionableWarningsReport;
	}

	it("f0 survives turn N+1 (carried once) and is gone by turn N+2 (marker spent)", async () => {
		const {
			writeDeferredActionableWarningsReport,
			publishActionableWarningsReport,
		} = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [f0] = makeSources(1);
		const liveFileSeq = () => 1;

		// Turn N: a deferred publish delivers f0's finding, recorded at seq 1.
		writeDeferredActionableWarningsReport({
			cacheManager,
			cwd: env.tmpDir,
			report: baseReport({
				turnIndex: 1,
				files: [
					{
						filePath: f0,
						displayPath: path.basename(f0),
						fileSeq: 1,
						generatedAt: new Date(2_000_000).toISOString(),
						warnings: [warning(f0, "n0")],
					},
				],
			}),
			getFileSeq: liveFileSeq,
		});

		// Turn N+1: in-band publish, no new findings, f0 unmoved -- carries it
		// forward (the ONE-turn delivery window) and spends the marker.
		publishActionableWarningsReport(
			cacheManager,
			env.tmpDir,
			baseReport({ turnIndex: 2, files: [] }),
			{ origin: "in-band", getFileSeq: liveFileSeq },
		);
		const afterN1 = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect((afterN1?.files ?? []).map((f) => f.filePath)).toEqual([f0]);

		// Turn N+2: another in-band publish, still nothing new, f0 STILL
		// unmoved. Pre-fix (marker spend deleted) f0's carried entry never lost
		// its "deferred" marker in turn N+1, so it would still pass the scope
		// guard here and accumulate forever.
		publishActionableWarningsReport(
			cacheManager,
			env.tmpDir,
			baseReport({ turnIndex: 3, files: [] }),
			{ origin: "in-band", getFileSeq: liveFileSeq },
		);
		const afterN2 = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect((afterN2?.files ?? []).map((f) => f.filePath)).toEqual([]);
	});
});

/**
 * #2504 review round 7 (F4) — round 6's removal of the same-`sessionId` gate
 * reasoned that exact `fileSeq` equality subsumed it: an unmoved file's live
 * seq always equals its recorded entry's seq, whether that is "this session,
 * untouched" or "a resumed process whose `_fileSeq` map reset to 0". That
 * reasoning breaks at `fileSeq` 0 for a genuinely DIFFERENT session (not a
 * resume of the same one): `mcp/analyze.ts` and `mcp/session.ts` register
 * turn-state ranges through their own `CacheManager`, never bumping the
 * extension runtime's `_fileSeq`, so an MCP-touched file can persist a
 * report entry at seq 0 under a foreign `sessionId`. The current session's
 * OWN live `getFileSeq` for a file it has never touched also answers 0, so
 * `0 !== 0` reads FALSE and the foreign entry was carried as if it were this
 * session's own unmoved file.
 */
describe("#2504 r7 F4 — a foreign session's zero-seq entry no longer passes the equality gate", () => {
	function warning(
		filePath: string,
		id: string,
	): ActionableWarningsReport["files"][number]["warnings"][number] {
		return {
			id,
			filePath,
			displayPath: path.basename(filePath),
			line: 1,
			severity: "warning",
			tool: "typescript",
			message: `finding ${id}`,
			actions: [],
			suppressed: false,
			origin: "lsp",
		};
	}

	function baseReport(
		over: Partial<ActionableWarningsReport>,
	): ActionableWarningsReport {
		return {
			generatedAt: new Date(2_000_000).toISOString(),
			scope: "turn_delta",
			sessionId: "lens-test",
			turnIndex: 1,
			projectSeqStart: 0,
			projectSeqEnd: 1,
			deltaOnly: true,
			includeLspCodeActions: true,
			files: [],
			summary: {
				warnings: 0,
				unsuppressed: 0,
				byTier: { warning: 0, info: 0, hint: 0 },
				suppressed: 0,
				files: 0,
				actions: 0,
				autoFixEligible: 0,
			},
			...over,
		} as ActionableWarningsReport;
	}

	it("drops a fileSeq-0 entry stamped by a different sessionId instead of carrying it", async () => {
		const { publishActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [foreign] = makeSources(1);

		// A foreign process (an MCP session, distinct sessionId) persisted this
		// entry at fileSeq 0 -- its own turn-state ranges never touched the
		// extension runtime's _fileSeq map.
		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				sessionId: "mcp-foreign-session",
				turnIndex: 5,
				projectSeqEnd: 5,
				files: [
					{
						filePath: foreign,
						displayPath: path.basename(foreign),
						fileSeq: 0,
						generatedAt: new Date(2_000_000).toISOString(),
						warnings: [warning(foreign, "FOREIGN-0")],
						origin: "deferred" as const,
					},
				],
			}),
			env.tmpDir,
		);

		// This session has never touched `foreign` either -- its own live
		// getFileSeq also answers 0, which pre-fix made the entry read as
		// "this session, unmoved".
		const result = publishActionableWarningsReport(
			cacheManager,
			env.tmpDir,
			baseReport({
				sessionId: "lens-current-session",
				turnIndex: 1,
				projectSeqEnd: 1,
				files: [],
			}),
			{
				origin: "in-band",
				getFileSeq: () => 0,
			},
		);

		expect(result.droppedFiles).toContain(path.basename(foreign));
		expect(
			(result.report.files ?? []).some((f) => f.filePath === foreign),
		).toBe(false);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect((persisted?.files ?? []).some((f) => f.filePath === foreign)).toBe(
			false,
		);
	});

	it("still carries a fileSeq-0 entry from the SAME sessionId (a genuinely untouched file)", async () => {
		const { publishActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [same] = makeSources(1);

		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				sessionId: "lens-shared-session",
				turnIndex: 5,
				projectSeqEnd: 5,
				files: [
					{
						filePath: same,
						displayPath: path.basename(same),
						fileSeq: 0,
						generatedAt: new Date(2_000_000).toISOString(),
						warnings: [warning(same, "SAME-0")],
						origin: "deferred" as const,
					},
				],
			}),
			env.tmpDir,
		);

		const result = publishActionableWarningsReport(
			cacheManager,
			env.tmpDir,
			baseReport({
				sessionId: "lens-shared-session",
				turnIndex: 6,
				projectSeqEnd: 6,
				files: [],
			}),
			{
				origin: "in-band",
				getFileSeq: () => 0,
			},
		);

		expect(result.droppedFiles).not.toContain(path.basename(same));
		expect((result.report.files ?? []).some((f) => f.filePath === same)).toBe(
			true,
		);
	});

	// #2504 review round 8 (S2): the ledger reason for an in-band carry-forward
	// drop said "changed before this turn's in-band publish could keep them"
	// unconditionally, but this scenario (a foreign sessionId, seqs matching)
	// drops the entry WITHOUT its file having changed on disk -- the reason
	// must name the session boundary, not assert a change that never happened.
	it("names the session boundary, not a file change, when the drop is a foreign-sessionId drop", async () => {
		const { publishActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [foreign] = makeSources(1);

		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				sessionId: "mcp-foreign-session",
				turnIndex: 5,
				projectSeqEnd: 5,
				files: [
					{
						filePath: foreign,
						displayPath: path.basename(foreign),
						fileSeq: 0,
						generatedAt: new Date(2_000_000).toISOString(),
						warnings: [warning(foreign, "FOREIGN-0")],
						origin: "deferred" as const,
					},
				],
			}),
			env.tmpDir,
		);

		publishActionableWarningsReport(
			cacheManager,
			env.tmpDir,
			baseReport({
				sessionId: "lens-current-session",
				turnIndex: 1,
				projectSeqEnd: 1,
				files: [],
			}),
			{
				origin: "in-band",
				getFileSeq: () => 0,
			},
		);

		const group = getDegradationSummary().find(
			(g) => g.kind === "actionable-warnings-inband-superseded",
		);
		const reason = group?.latestReasons.at(-1)?.reason ?? "";
		expect(reason).not.toContain("changed before this turn's in-band publish");
		expect(reason.toLowerCase()).toContain("session");
	});
});

/**
 * #2504 review round 7 (F5) — the scope-guard drop (an entry whose
 * carry-forward window already closed) has always traced to `dbg`, because
 * that loss is expected, not a fault. The STALE drop right below it -- a
 * carried-forward deferred entry whose file genuinely moved between the
 * deferral and this in-band publish -- is the loss that is NOT expected
 * (content changed out from under the delivery), and it had neither a dbg
 * line nor a degradation-ledger entry. The deferred origin's own version of
 * this same loss (`writeDeferredActionableWarningsReport`) has always
 * counted it; this pins the in-band side to the same accounting.
 */
describe("#2504 r7 F5 — the in-band stale drop is no longer silent", () => {
	function warning(
		filePath: string,
		id: string,
	): ActionableWarningsReport["files"][number]["warnings"][number] {
		return {
			id,
			filePath,
			displayPath: path.basename(filePath),
			line: 1,
			severity: "warning",
			tool: "typescript",
			message: `finding ${id}`,
			actions: [],
			suppressed: false,
			origin: "lsp",
		};
	}

	function baseReport(
		over: Partial<ActionableWarningsReport>,
	): ActionableWarningsReport {
		return {
			generatedAt: new Date(2_000_000).toISOString(),
			scope: "turn_delta",
			sessionId: "lens-test",
			turnIndex: 1,
			projectSeqStart: 0,
			projectSeqEnd: 1,
			deltaOnly: true,
			includeLspCodeActions: true,
			files: [],
			summary: {
				warnings: 0,
				unsuppressed: 0,
				byTier: { warning: 0, info: 0, hint: 0 },
				suppressed: 0,
				files: 0,
				actions: 0,
				autoFixEligible: 0,
			},
			...over,
		} as ActionableWarningsReport;
	}

	it("traces the drop via dbg and counts it on the degradation ledger", async () => {
		const { publishActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [moved] = makeSources(1);
		const dbgLines: string[] = [];

		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				sessionId: "lens-test",
				turnIndex: 5,
				projectSeqEnd: 5,
				files: [
					{
						filePath: moved,
						displayPath: path.basename(moved),
						fileSeq: 5,
						generatedAt: new Date(2_000_000).toISOString(),
						warnings: [warning(moved, "MOVED-5")],
						origin: "deferred" as const,
					},
				],
			}),
			env.tmpDir,
		);

		// `moved` was edited again since the deferred pull recorded fileSeq 5.
		const result = publishActionableWarningsReport(
			cacheManager,
			env.tmpDir,
			baseReport({
				sessionId: "lens-test",
				turnIndex: 6,
				projectSeqEnd: 6,
				files: [],
			}),
			{
				origin: "in-band",
				getFileSeq: () => 9,
				dbg: (msg) => dbgLines.push(msg),
			},
		);

		expect(result.droppedFiles).toContain(path.basename(moved));
		expect(
			dbgLines.some(
				(line) =>
					line.includes("in-band") &&
					line.includes("dropped") &&
					line.includes(path.basename(moved)),
			),
		).toBe(true);

		const summary = getDegradationSummary();
		const group = summary.find(
			(g) => g.kind === "actionable-warnings-inband-superseded",
		);
		expect(group?.count).toBeGreaterThanOrEqual(1);
	});
});

/**
 * #2504 review round 7 (F2/F3) — round 6 fixed the ADVISORY text to read
 * `publishResult.report` (the MERGED report) instead of the pre-merge
 * `report` this turn assembled, but nothing pinned it: reverting that one
 * line back to `report` left the existing suite green. The TELEMETRY event
 * right below it (`logActionableWarningsEvent`'s `metadata.unsuppressed`)
 * still read the pre-merge `report` even after round 6 -- a rescued
 * deferred finding was correctly advised but logged as worth 0, and
 * `scripts/analyze-pi-lens-logs.mjs` sums that field. This test drives the
 * real `handleTurnEnd` path (not a hand-fed report) for both halves: a
 * deferred delivery in turn N, then a turn N+1 with no new findings of its
 * own, and checks both surfaces the merge is supposed to feed.
 */
describe("#2504 r7 F2/F3 — the advisory AND the telemetry both read the merged report", () => {
	it("turn N+1's advisory mentions turn N's deferred finding, and its telemetry counts it", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const [deferredFile, nextFile] = makeSources(2);

		// Turn N: one modified file, nothing primed, so its pull defers.
		runtime.beginTurn();
		cacheManager.addModifiedRange(
			deferredFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		armOneActionableWarning(path.basename(deferredFile));
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);
		// Land turn N's deferred report before turn N+1 starts.
		await settlesWithin(_awaitDeferredLspPullForTest(), 8_000);
		const afterDefer = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		// Premise check: the deferred finding really landed.
		expect(afterDefer?.summary.files).toBe(1);

		loggedActionableWarningsEvents.length = 0;

		// Turn N+1: touches a DIFFERENT file, nothing primed for it either (so
		// it too defers and contributes nothing in-band), and records no
		// dispatch finding of its own. This turn's own pre-merge report is
		// therefore empty; only the merge with what turn N deferred gives it
		// anything to advise or log.
		runtime.beginTurn();
		cacheManager.addModifiedRange(
			nextFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect((persisted?.files ?? []).map((f) => f.filePath)).toContain(
			deferredFile,
		);

		const findings = cacheManager.readCache<{ content: string }>(
			"turn-end-findings",
			env.tmpDir,
		)?.data;
		expect(findings?.content).toContain(path.basename(deferredFile));

		const advisoryEvents = loggedActionableWarningsEvents.filter(
			(e) => e.event === "advisory_injected" || e.event === "advisory_skipped",
		);
		expect(advisoryEvents.length).toBeGreaterThan(0);
		const last = advisoryEvents[advisoryEvents.length - 1];
		expect(last.event).toBe("advisory_injected");
		expect(last.metadata?.unsuppressed).toBe(1);

		// Drain turn N+1's own deferred loop so nothing outlives the test.
		await settlesWithin(_awaitDeferredLspPullForTest(), 8_000);
	});
});
