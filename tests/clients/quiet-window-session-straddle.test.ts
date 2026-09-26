/**
 * #3499: a session-1 quiet window must not write cascade state into the
 * session that replaced it.
 *
 * pi caches the extension module per cwd, so `/new`, fork, or a resume into
 * the same cwd keeps ONE module-level `runtime` for both sessions. The
 * quiet window is fire-and-forget from `agent_settled`; its cascade settle
 * awaits up to 15 s and its tier-3 reconcile awaits warm clients. A
 * replacement inside either wait runs `resetForSession` (generation bump,
 * cascade state cleared), and before #3499 the late write put session 1's run
 * back, where session 2's first turn_end consumed and delivered it. The
 * TLA+ model is `formal/session-straddle/` (`StraddleState`,
 * `StraddleDelivery`, and the `Fix*` mutants each case below names).
 *
 * The host is the test: `agent_settled` -> `void runQuietWindow(...)`, the
 * replacement's `handleSessionStart` -> `resetCascadeTierSessionState()` +
 * `runtime.resetForSession()` (runtime-session.ts, the two adjacent calls),
 * and session 2's turn_end -> `settleCascadeRuns` + `consumeCascadeRuns`.
 * Everything else is the real code: `RuntimeCoordinator`, the built-in
 * quiet-window tasks, the tier-3 reconcile task, and the ledger. The waits
 * are gates (`tests/support/fault-injection.ts`) and fake timers; nothing
 * here sleeps on the wall clock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CascadeRun } from "../../clients/cascade-types.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_getOutstandingCascadeTouchesForTests,
	_resetCascadeTierReconcileRegistrationForTests,
	_resetOutstandingCascadeTouchesForTests,
	_resetTierAwareCascadeEnabledForTests,
	recordOutstandingCascadeTouch,
	registerCascadeTierReconcileTask,
	resetCascadeTierSessionState,
} from "../../clients/lsp/cascade-tier.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	_resetBuiltinQuietWindowRegistrationForTests,
	_resetQuietWindowEnabledForTests,
	_resetQuietWindowTasksForTests,
	registerBuiltinQuietWindowTasks,
	runQuietWindow,
} from "../../clients/quiet-window.js";
import {
	MAX_PENDING_CASCADE_RUNS,
	RuntimeCoordinator,
} from "../../clients/runtime-coordinator.js";
import {
	computeCascadeForFile,
	resetDispatchBaselines,
} from "../../clients/dispatch/integration.js";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "../../clients/review-graph/types.js";
import { gatedPromise } from "../support/fault-injection.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "./test-utils.js";

// #3512: the stray cases drive the real `computeCascadeForFile`. Its graph and
// its LSP service are the two boundaries replaced here, as in
// cascade-compute.test.ts; everything else in those modules stays real.
const cascadeMocks = vi.hoisted(() => ({
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	getLSPService: vi.fn(),
}));

vi.mock("../../clients/review-graph/service.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/review-graph/service.js")
	>()),
	buildOrUpdateGraph: cascadeMocks.buildOrUpdateGraph,
	computeImpactCascade: cascadeMocks.computeImpactCascade,
	computeTransitiveImpact: () => ({
		seedFile: "",
		hits: [],
		truncated: false,
		maxDepthReached: 0,
	}),
	formatImpactCascade: () => "impact header",
}));

vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: cascadeMocks.getLSPService,
}));

const WAIT_MS = 15_000;
const FILE = "/proj/a.ts";
const NEIGHBOR = "/proj/b.ts";

function run(filePath: string, projectSeq = 3): CascadeRun {
	return {
		filePath,
		origin: { projectSeq, turnSeq: 4 },
		result: undefined,
		neighborCount: 2,
		diagnosticCount: 3,
	};
}

function staleWriteSubjects(): string[] {
	return (
		getDegradationSummary()
			.find((entry) => entry.kind === "generation-guard-stale-write")
			?.latestReasons.map((entry) => entry.subject) ?? []
	);
}

/** The replacement's `handleSessionStart`, as far as this state goes. */
function replaceSession(runtime: RuntimeCoordinator): void {
	resetCascadeTierSessionState();
	runtime.resetForSession();
}

/** Session 2's turn_end: settle what is parked, then consume. */
async function turnEnd(runtime: RuntimeCoordinator): Promise<CascadeRun[]> {
	const settle = runtime.settleCascadeRuns(WAIT_MS, {
		trackTurnEndClock: true,
	});
	await vi.advanceTimersByTimeAsync(WAIT_MS);
	await settle;
	return runtime.consumeCascadeRuns();
}

/** A warm client whose per-file publish for NEIGHBOR landed after the touch. */
function warmService(
	gate?: { entered: () => void; open: Promise<void> },
	publishedFor: string[] = [NEIGHBOR],
) {
	const diagnostics = [
		{
			severity: 1,
			message: "late neighbour error",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		},
	];
	return {
		getWarmClientForFile: async () => {
			if (gate) {
				gate.entered();
				await gate.open;
			}
			return {
				client: {
					serverId: "typescript",
					getAllDiagnostics: () =>
						new Map(
							publishedFor.map((file) => [
								normalizeMapKey(file),
								{ ts: Date.now(), diags: diagnostics },
							]),
						),
				},
			};
		},
	};
}

describe("quiet-window cascade writes across a session replacement (#3499)", () => {
	const originalWait = process.env.PI_LENS_QUIET_WINDOW_WAIT_MS;
	const originalRegistry = process.env.PI_LENS_INSTANCE_REGISTRY;

	beforeEach(() => {
		vi.useFakeTimers();
		process.env.PI_LENS_QUIET_WINDOW_WAIT_MS = String(WAIT_MS);
		// The heartbeat task is a registry no-op; it still samples, harmlessly.
		process.env.PI_LENS_INSTANCE_REGISTRY = "0";
		_resetQuietWindowTasksForTests();
		_resetQuietWindowEnabledForTests();
		_resetBuiltinQuietWindowRegistrationForTests();
		_resetCascadeTierReconcileRegistrationForTests();
		_resetTierAwareCascadeEnabledForTests();
		_resetOutstandingCascadeTouchesForTests();
		resetDegradationLedger();
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalWait === undefined)
			delete process.env.PI_LENS_QUIET_WINDOW_WAIT_MS;
		else process.env.PI_LENS_QUIET_WINDOW_WAIT_MS = originalWait;
		if (originalRegistry === undefined)
			delete process.env.PI_LENS_INSTANCE_REGISTRY;
		else process.env.PI_LENS_INSTANCE_REGISTRY = originalRegistry;
		_resetQuietWindowTasksForTests();
		_resetBuiltinQuietWindowRegistrationForTests();
		_resetCascadeTierReconcileRegistrationForTests();
		_resetOutstandingCascadeTouchesForTests();
		resetDegradationLedger();
	});

	/**
	 * Builds the session-1 runtime and registers the quiet-window tasks in
	 * index.ts's order: the built-ins (settle, heartbeat), then the tier-3
	 * reconcile, whose `onResolvedFound` appends a run as index.ts does.
	 */
	function sessionOne(lsp = warmService()) {
		const runtime = new RuntimeCoordinator();
		runtime.resetForSession();
		registerBuiltinQuietWindowTasks(() => runtime);
		registerCascadeTierReconcileTask(() => lsp as never, {
			onResolvedFound: ({ filePath, diagnostics }) =>
				runtime.appendCascadeRun({
					...run(filePath),
					diagnosticCount: diagnostics.length,
				}),
		});
		return runtime;
	}

	it("drops a session-1 settle that resolves after the replacement, so session 2's turn_end delivers nothing", async () => {
		// StraddleDelivery; the settle arm (FixReconcileOnly without it).
		const runtime = sessionOne();
		for (let i = 0; i < 3; i++) runtime.bumpFileSeq(FILE);
		const originSeq = runtime.projectSeq;
		const compute = gatedPromise<CascadeRun>();
		runtime.appendCascadePromise(compute.promise);

		const quiet = runQuietWindow({ runtime, dbg: () => {} });
		replaceSession(runtime);
		compute.resolve(run(FILE, originSeq));
		await quiet;

		const delivered = await turnEnd(runtime);
		console.log(
			`[StraddleDelivery] delivered=${JSON.stringify(delivered.map((r) => r.filePath))} ` +
				`getFilesChangedSince(${originSeq})=${JSON.stringify(runtime.getFilesChangedSince(originSeq))} ` +
				`staleWrites=${JSON.stringify(staleWriteSubjects())}`,
		);
		expect(delivered).toEqual([]);
		expect(staleWriteSubjects()).toEqual([`runtime-session:${FILE}`]);
	});

	it("drops the re-park of a session-1 compute still pending at the settle cap, so session 2's turn_end settle never picks it up", async () => {
		// StraddleState: the re-park half of the settle arm.
		const runtime = sessionOne();
		const compute = gatedPromise<CascadeRun>();
		runtime.appendCascadePromise(compute.promise);

		const quiet = runQuietWindow({ runtime, dbg: () => {} });
		replaceSession(runtime);
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await quiet;

		// Session 1's compute resolves only now, inside session 2's settle.
		const delivered = turnEnd(runtime);
		compute.resolve(run(FILE));
		const runs = await delivered;
		console.log(
			`[StraddleState] delivered=${JSON.stringify(runs.map((r) => r.filePath))} staleWrites=${JSON.stringify(staleWriteSubjects())}`,
		);
		expect(runs).toEqual([]);
		expect(staleWriteSubjects()).toEqual(["runtime-session:cascade-pending"]);
	});

	it("drops a session-1 tier-3 reconcile append that resolves after the replacement", async () => {
		// FixSettleOnly: the reconcile arm.
		const entered = gatedPromise<void>();
		const clientGate = gatedPromise<void>();
		const runtime = sessionOne(
			warmService({
				entered: () => entered.resolve(),
				open: clientGate.promise,
			}),
		);
		recordOutstandingCascadeTouch({
			filePath: NEIGHBOR,
			serverId: "typescript",
			touchedAt: Date.now() - 50,
		});

		const quiet = runQuietWindow({ runtime, dbg: () => {} });
		// The settle has nothing parked; wait for the reconcile to reach its
		// warm-client lookup, then replace the session under it.
		await entered.promise;
		replaceSession(runtime);
		clientGate.resolve();
		await quiet;

		const delivered = runtime.consumeCascadeRuns();
		console.log(
			`[Reconcile] delivered=${JSON.stringify(delivered.map((r) => r.filePath))} staleWrites=${JSON.stringify(staleWriteSubjects())}`,
		);
		expect(delivered).toEqual([]);
		expect(staleWriteSubjects()).toEqual([`runtime-session:${NEIGHBOR}`]);
	});

	it("delivers a touch recorded after the replacement even when session 2's next window is more than 15 minutes away", async () => {
		// Shape 54, the no-drop direction (#3499 rounds 1-2, probes P1 and P4).
		// The replacement lands inside the settle wait and session 2 records its
		// own tier-3 touch. Session 2's agent_settled window is skipped (a window
		// is still in progress). The stale window's reconcile starts only after
		// the settle, in session 2. It captures its generation when it drains, so
		// it delivers the touch for session 2 now. A window-start capture would
		// leave it (FixNoStartCheck, or the round-1 start check) until session
		// 2's next window, and a touch older than OUTSTANDING_TOUCH_MAX_AGE_MS
		// (15 min) expires unanswered.
		//
		// The reconcile cannot tell this touch from a stray that a still-running
		// session-1 compute records after the reset; since #3512 the record site
		// drops the stray instead (the #3512 describe below).
		const runtime = sessionOne();
		const compute = gatedPromise<CascadeRun>();
		runtime.appendCascadePromise(compute.promise);

		const stale = runQuietWindow({ runtime, dbg: () => {} });
		replaceSession(runtime);
		recordOutstandingCascadeTouch({
			filePath: NEIGHBOR,
			serverId: "typescript",
			touchedAt: Date.now() - 50,
		});
		const skipped = vi.fn();
		await runQuietWindow({ runtime, dbg: skipped });
		compute.resolve(run(FILE));
		await stale;

		const afterStale = {
			runs: runtime.hasCascadeRuns(),
			touches: _getOutstandingCascadeTouchesForTests().map((t) => t.filePath),
		};
		// Session 2's next prompt settles 16 minutes later.
		await vi.advanceTimersByTimeAsync(16 * 60_000);
		await runQuietWindow({ runtime, dbg: () => {} });
		const delivered = runtime.consumeCascadeRuns();
		console.log(
			`[FreshTouch] afterStale=${JSON.stringify(afterStale)} deliveredAt16min=${JSON.stringify(delivered.map((r) => r.filePath))} staleWrites=${JSON.stringify(staleWriteSubjects())}`,
		);
		expect(skipped).toHaveBeenCalledWith(
			expect.stringContaining("a previous run is still in progress"),
		);
		expect(delivered.map((r) => r.filePath)).toEqual([NEIGHBOR]);
		expect(afterStale).toEqual({ runs: true, touches: [] });
		expect(staleWriteSubjects()).toEqual([`runtime-session:${FILE}`]);
	});

	it("delivers every arm's write when no replacement lands during the window", async () => {
		// Fix (pass), the inverse direction of every guard: same session, the
		// settle appends, re-parks, and the reconcile appends.
		const runtime = sessionOne();
		const settled = gatedPromise<CascadeRun>();
		const pending = gatedPromise<CascadeRun>();
		runtime.appendCascadePromise(settled.promise);
		runtime.appendCascadePromise(pending.promise);
		recordOutstandingCascadeTouch({
			filePath: NEIGHBOR,
			serverId: "typescript",
			touchedAt: Date.now() - 50,
		});

		const quiet = runQuietWindow({ runtime, dbg: () => {} });
		settled.resolve(run(FILE));
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		await quiet;

		// The re-parked compute resolves inside the next turn_end's settle.
		const delivered = turnEnd(runtime);
		pending.resolve(run("/proj/c.ts"));
		const runs = await delivered;
		// Window order: the settle's append, the reconcile's, then the re-park.
		expect(runs.map((r) => r.filePath)).toEqual([FILE, NEIGHBOR, "/proj/c.ts"]);
		expect(staleWriteSubjects()).toEqual([]);
	});

	describe("the overflow admission path and session-1 strays (#3512)", () => {
		beforeEach(() => {
			resetDispatchBaselines();
			cascadeMocks.buildOrUpdateGraph.mockReset().mockResolvedValue({
				version: "test",
				builtAt: new Date().toISOString(),
				nodes: new Map(),
				edges: [],
				edgesByFrom: new Map(),
				edgesByTo: new Map(),
				fileNodes: new Map(),
				symbolNodesByFile: new Map(),
				changedSymbolsByFile: new Map(),
			} satisfies ReviewGraph);
			cascadeMocks.computeImpactCascade.mockReset();
			cascadeMocks.getLSPService.mockReset();
		});

		/** Park the cap's worth of computes that never settle. */
		function fillPending(runtime: RuntimeCoordinator): void {
			for (let i = 0; i < MAX_PENDING_CASCADE_RUNS; i++)
				runtime.appendCascadePromise(gatedPromise<CascadeRun>().promise);
		}

		it("drops session 1's 33rd compute, admitted past the cap, and delivers the one session 2 admits past the cap", async () => {
			// OverflowAdmission (pass) against FixNoAdmissionGuard (no guard) and
			// FixAdmissionHoist (one handle reused across admissions). The first
			// half is the #3499 reviewer's probe: 33 gated computes, a
			// replacement, then compute #33 resolves.
			const runtime = sessionOne();
			fillPending(runtime);
			const sessionOneOverflow = gatedPromise<CascadeRun>();
			runtime.appendCascadePromise(sessionOneOverflow.promise);

			replaceSession(runtime);
			fillPending(runtime);
			const sessionTwoOverflow = gatedPromise<CascadeRun>();
			runtime.appendCascadePromise(sessionTwoOverflow.promise);
			sessionOneOverflow.resolve(run(FILE));
			sessionTwoOverflow.resolve(run("/proj/c.ts"));

			const delivered = await turnEnd(runtime);
			console.log(
				`[OverflowAdmission] delivered=${JSON.stringify(delivered.map((r) => r.filePath))} staleWrites=${JSON.stringify(staleWriteSubjects())}`,
			);
			expect(delivered.map((r) => r.filePath)).toEqual(["/proj/c.ts"]);
			expect(staleWriteSubjects()).toEqual([`runtime-session:${FILE}`]);
		});

		it("drops a touch a session-1 compute records after the reset and delivers the touch session 2's own compute records", async () => {
			// StrayTouch (pass) against FixNoStrayGuard, FixStrayRecordCapture
			// (stamping at record time, which the issue rules out) and
			// FixDispatchHoist. Both touches land after the reset, so only the
			// generation each dispatch captured when it started tells them apart.
			const env = setupTestEnvironment("pi-lens-3512-stray-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const stray = path.join(env.tmpDir, "src", "stray.ts");
				const own = path.join(env.tmpDir, "src", "own.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(stray, "import { x } from './primary';\n");
				fs.writeFileSync(own, "import { x } from './primary';\n");
				const impact = (neighbor: string): ImpactCascadeResult => ({
					filePath: primary,
					changedSymbols: ["changed"],
					directImporters: [neighbor],
					directCallers: [],
					neighborFiles: [neighbor],
					riskFlags: [],
				});
				cascadeMocks.computeImpactCascade
					.mockReturnValueOnce(impact(stray))
					.mockReturnValueOnce(impact(own));
				const strayTouchEntered = gatedPromise<void>();
				const strayTouchGate = gatedPromise<void>();
				cascadeMocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					// No passive snapshot: every neighbour takes the active touch.
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					getCapabilitySnapshots: vi.fn().mockResolvedValue([
						{
							serverId: "typescript",
							root: env.tmpDir,
							operationSupport: {},
							workspaceDiagnosticsSupport: { mode: "push-only" },
							advertisedCommands: [],
							rawCapabilityKeys: [],
						},
					]),
					getClientForFile: vi
						.fn()
						.mockResolvedValue({ client: { serverId: "typescript" } }),
					// Session 1's compute is inside its touch when the replacement
					// lands.
					touchFile: vi.fn(async (filePath: string) => {
						if (filePath !== stray) return;
						strayTouchEntered.resolve();
						await strayTouchGate.promise;
					}),
					getDiagnostics: vi.fn(),
				});
				const runtime = sessionOne(warmService(undefined, [stray, own]));
				// runtime-tool-result.ts captures when it dispatches the pipeline,
				// which hands the handle on to the compute.
				const sessionOneCompute = computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
					sessionGeneration: runtime.captureSessionGeneration(),
				});
				await strayTouchEntered.promise;

				replaceSession(runtime);
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
					sessionGeneration: runtime.captureSessionGeneration(),
				});
				strayTouchGate.resolve();
				await sessionOneCompute;
				const recorded = _getOutstandingCascadeTouchesForTests().map((t) =>
					path.basename(t.filePath),
				);

				// Session 2's window: its publishes land after both touches.
				await vi.advanceTimersByTimeAsync(100);
				await runQuietWindow({ runtime, dbg: () => {} });
				const delivered = runtime.consumeCascadeRuns();
				console.log(
					`[StrayTouch] recorded=${JSON.stringify(recorded)} delivered=${JSON.stringify(delivered.map((r) => path.basename(r.filePath)))} staleWrites=${JSON.stringify(staleWriteSubjects().map((s) => s.replace(env.tmpDir, "<tmp>")))}`,
				);
				expect(delivered.map((r) => r.filePath)).toEqual([own]);
				expect(staleWriteSubjects()).toEqual([`runtime-session:${stray}`]);
			} finally {
				env.cleanup();
			}
		});
	});
});
