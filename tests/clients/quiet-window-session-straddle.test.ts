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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CascadeRun } from "../../clients/cascade-types.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
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
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { gatedPromise } from "../support/fault-injection.js";

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
function warmService(gate?: { entered: () => void; open: Promise<void> }) {
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
						new Map([
							[
								normalizeMapKey(NEIGHBOR),
								{ ts: Date.now(), diags: diagnostics },
							],
						]),
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

	it("drops a stray touch a session-1 compute records after the replacement, because the window captured its generation before the settle", async () => {
		// FixReconcileLateCapture. The replacement lands inside the settle wait;
		// the session-1 compute then records its tier-3 touch (as the cascade
		// lane does, clients/dispatch/integration.ts recordOutstandingCascadeTouch)
		// and resolves. The reconcile task starts only after the settle, already
		// in session 2: a generation captured at TASK start would read current.
		const runtime = sessionOne();
		const compute = gatedPromise<CascadeRun>();
		runtime.appendCascadePromise(compute.promise);

		const quiet = runQuietWindow({ runtime, dbg: () => {} });
		replaceSession(runtime);
		recordOutstandingCascadeTouch({
			filePath: NEIGHBOR,
			serverId: "typescript",
			touchedAt: Date.now() - 50,
		});
		compute.resolve(run(FILE));
		await quiet;

		const delivered = runtime.consumeCascadeRuns();
		console.log(
			`[LateCapture] delivered=${JSON.stringify(delivered.map((r) => r.filePath))} staleWrites=${JSON.stringify(staleWriteSubjects())}`,
		);
		expect(delivered).toEqual([]);
		expect(staleWriteSubjects()).toEqual([
			`runtime-session:${FILE}`,
			`runtime-session:${NEIGHBOR}`,
		]);
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
		expect(runs.map((r) => r.filePath).sort()).toEqual([
			FILE,
			NEIGHBOR,
			"/proj/c.ts",
		]);
		expect(staleWriteSubjects()).toEqual([]);
	});
});
